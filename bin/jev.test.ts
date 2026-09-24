import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

async function jev(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `--no-env-file`: the checkout's own `.env` must not decide what these assert.
  const proc = Bun.spawn(['bun', '--no-env-file', 'bin/jev.ts', ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const DRY_RUN = ['run', 'mcp-error-triage', '--input', 'samples/mcp-errors.jsonl', '--dry-run'];

describe('jev CLI flags', () => {
  test.each([
    ['--concurrency', 'abc'],
    ['--concurrency', '0'],
    ['--limit', 'abc'],
    ['--bins', '0'],
    ['--provider', 'foo'],
  ])('rejects %s %s by name, without a stack trace', async (flag, value) => {
    const { exitCode, stderr } = await jev([...DRY_RUN, flag, value]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(flag.slice(2));
    expect(stderr).not.toContain('    at ');
  });

  test('--limit caps the records sent', async () => {
    const { exitCode, stderr } = await jev([...DRY_RUN, '--limit', '2']);
    expect(exitCode).toBe(0);
    expect(stderr).toContain('2 record(s) would be sent');
  });
});

describe('jev --dry-run', () => {
  test('previews the OpenRouter payload by default: entries JSON-encoded', async () => {
    const { stdout } = await jev(DRY_RUN);
    const payload = JSON.parse(stdout);
    expect(payload.model).toBe('typesafe/jev-1.13');
    expect(typeof payload.questions.origin.instructions).toBe('string');
  });

  test('follows JEV_PROVIDER, as the real call would', async () => {
    const { stdout } = await jev(DRY_RUN, { JEV_PROVIDER: 'typesafe' });
    const payload = JSON.parse(stdout);
    expect(payload.model).toBe('jev-1.13.0');
    expect(typeof payload.questions.origin.instructions).toBe('object');
  });

  test('ask honors --provider and --model', async () => {
    const { stdout } = await jev([
      'ask',
      '--state',
      'x',
      '--noul',
      'urgent=Is it urgent?',
      '--provider',
      'typesafe',
      '--model',
      'jev-9',
      '--dry-run',
    ]);
    expect(JSON.parse(stdout).model).toBe('jev-9');
  });

  test('builds per-record questions for the first record', async () => {
    const { exitCode, stdout } = await jev([
      'run',
      'tool-ranking',
      '--input',
      'samples/tool-queries.jsonl',
      '--dry-run',
    ]);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.state).toEqual({ request: 'Will it snow in Denver this weekend?' });
    expect(Object.keys(payload.questions.tool.criteria)).toContain('weather_get_forecast');
  });

  test('--resume sends only the records the rows file lacks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-resume-'));
    const rows = join(dir, 'prior.jsonl');
    await Bun.write(rows, '{"id":"t1","experiment":"ticket-routing"}\n');
    const { exitCode, stderr } = await jev([
      'run',
      'ticket-routing',
      '--input',
      'samples/tickets.jsonl',
      '--resume',
      rows,
      '--dry-run',
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain('resuming: 1 row(s) on disk, 4 record(s) to send');
  });

  test('--resume refuses the rows of another experiment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-resume-'));
    const rows = join(dir, 'prior.jsonl');
    await Bun.write(rows, '{"id":"t1","experiment":"mcp-error-triage"}\n');
    const { exitCode, stderr } = await jev([
      'run',
      'ticket-routing',
      '--input',
      'samples/tickets.jsonl',
      '--resume',
      rows,
      '--dry-run',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not "ticket-routing"');
  });

  test.each([
    [['--noul', 'a=x?', '--noul', 'a=y?'], 'question id "a" is used twice'],
    [['--noul', 'x?', '--choice', 'q1=pick|a,b'], 'question id "q1" is used twice'],
    [['--choice', 'pick|a,a'], 'repeats an entry'],
  ])('ask rejects %p', async (flags, message) => {
    const { exitCode, stderr } = await jev(['ask', '--state', 'x', ...flags, '--dry-run']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(message);
  });
});
