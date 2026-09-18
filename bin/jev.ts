#!/usr/bin/env bun
/**
 * bin/jev.ts — the entry point.
 *
 *   bun run jev run <experiment> --input <path|-> [--out results/] [--limit N]
 *                   [--concurrency 8] [--model M] [--provider openrouter|typesafe]
 *                   [--keep-input] [--keep-state] [--dry-run]
 *   bun run jev ask --state <text|@file> [--noul "id=question"]...
 *                   [--choice "id=question|optA,optB"]... [--score "id=question|l0,l1,l2"]...
 *   bun run jev list
 *   bun run jev calibrate --rows <rows.jsonl> --truth <truth.jsonl> [--bins 10]
 *   bun run jev stability <rows.jsonl> <rows.jsonl>...
 *
 * `run` writes one JSONL row per record plus a `.report.txt` to --out and prints
 * the report. `ask` is for one-off pokes without writing an experiment file.
 * `--dry-run` prints the first request payload and exits without calling Jev.
 * `calibrate` checks a run's probabilities against known answers (truth lines are
 * `{"id": "...", "truth": {"<question>": "<option>" | true | false}}`); `stability`
 * compares repeated runs over the same records. Neither calls Jev.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  calibrate,
  renderCalibration,
  renderStability,
  stability,
  type Truth,
} from '../src/analysis/index.ts';
import { JevClient, JevHttpError, type Provider, type State } from '../src/client/index.ts';
import { listExperiments, loadExperiment } from '../src/experiments/index.ts';
import { loadRecords } from '../src/input/index.ts';
import { choice, noul, type Questions, score } from '../src/questions/index.ts';
import { type RunRow, renderReport, runExperiment } from '../src/run/index.ts';

const USAGE = `usage:
  jev run <experiment> --input <path|-> [--out results/] [--limit N] [--concurrency 8]
          [--model M] [--provider openrouter|typesafe] [--keep-input] [--keep-state] [--dry-run]
  jev ask --state <text|@file> [--noul "id=q"]... [--choice "id=q|a,b"]... [--score "id=q|l0,l1"]...
  jev list
  jev calibrate --rows <rows.jsonl> --truth <truth.jsonl> [--bins 10]
  jev stability <rows.jsonl> <rows.jsonl>...`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    input: { type: 'string', short: 'i' },
    out: { type: 'string', short: 'o', default: 'results' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '8' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'keep-input': { type: 'boolean', default: false },
    'keep-state': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    state: { type: 'string' },
    noul: { type: 'string', multiple: true, default: [] },
    choice: { type: 'string', multiple: true, default: [] },
    score: { type: 'string', multiple: true, default: [] },
    rows: { type: 'string' },
    truth: { type: 'string' },
    bins: { type: 'string', default: '10' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

function makeClient(): JevClient {
  return new JevClient({
    ...(values.provider !== undefined && { provider: values.provider as Provider }),
    ...(values.model !== undefined && { model: values.model }),
  });
}

switch (command) {
  case 'list': {
    for (const name of await listExperiments()) console.log(name);
    break;
  }

  case 'run': {
    const ref = rest[0];
    if (!ref || !values.input) {
      console.error(USAGE);
      process.exit(1);
    }
    const experiment = await loadExperiment(ref);
    let records = await loadRecords(values.input);
    if (values.limit !== undefined) records = records.slice(0, Number(values.limit));
    if (records.length === 0) throw new Error(`no records in ${values.input}`);

    if (values['dry-run']) {
      const first = records[0];
      if (!first) throw new Error('unreachable: records is non-empty');
      const preview = new JevClient({
        provider: (values.provider as Provider | undefined) ?? 'openrouter',
        apiKey: 'dry-run',
        ...(values.model !== undefined && { model: values.model }),
      });
      console.log(
        JSON.stringify(
          preview.payload(experiment.state(first.data), experiment.questions),
          null,
          2,
        ),
      );
      console.error(`\n${records.length} record(s) would be sent. Dry run — nothing called.`);
      break;
    }

    const client = makeClient();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = resolve(values.out);
    await mkdir(outDir, { recursive: true });
    const rowsPath = join(outDir, `${experiment.name}-${stamp}.jsonl`);
    const reportPath = join(outDir, `${experiment.name}-${stamp}.report.txt`);
    const writer = Bun.file(rowsPath).writer();

    let done = 0;
    const outcome = await runExperiment(client, experiment, records, {
      concurrency: Number(values.concurrency),
      keepInput: values['keep-input'],
      keepState: values['keep-state'],
      onRow: (row) => {
        writer.write(`${JSON.stringify(row)}\n`);
        done += 1;
        if (done % 25 === 0 || done === records.length) {
          process.stderr.write(`\r${done}/${records.length}`);
        }
      },
      onFailure: (f) => {
        process.stderr.write(`\n! ${f.id}: ${f.error}\n`);
      },
    }).catch(async (error: unknown) => {
      await writer.end();
      if (!(error instanceof JevHttpError && error.isAuthFailure)) throw error;
      console.error(
        `\n${error.message}\nThe run stopped: the key was rejected. A key exported in the shell takes precedence over .env.`,
      );
      process.exit(1);
    });
    await writer.end();
    process.stderr.write('\n');

    const report = renderReport(experiment, outcome);
    await Bun.write(reportPath, `${report}\n`);
    console.log(report);
    console.log(`\nrows: ${rowsPath}\nreport: ${reportPath}`);
    if (outcome.failures.length > 0) process.exitCode = 2;
    break;
  }

  case 'ask': {
    if (!values.state) {
      console.error(USAGE);
      process.exit(1);
    }
    const state: State = values.state.startsWith('@')
      ? await Bun.file(values.state.slice(1)).text()
      : values.state;
    const questions = parseAdHocQuestions(values.noul, values.choice, values.score);
    if (Object.keys(questions).length === 0)
      throw new Error('ask needs at least one --noul/--choice/--score');
    if (values['dry-run']) {
      const preview = new JevClient({ provider: 'openrouter', apiKey: 'dry-run' });
      console.log(JSON.stringify(preview.payload(state, questions), null, 2));
      break;
    }
    const result = await makeClient().ask(state, questions);
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case 'calibrate': {
    if (!values.rows || !values.truth) {
      console.error(USAGE);
      process.exit(1);
    }
    const rows = await readJsonl<RunRow>(values.rows);
    const truth = new Map(
      (await readJsonl<{ id: string; truth: Truth }>(values.truth)).map((t) => [t.id, t.truth]),
    );
    console.log(renderCalibration(calibrate(rows, truth, Number(values.bins))));
    break;
  }

  case 'stability': {
    if (rest.length < 2) {
      console.error(USAGE);
      process.exit(1);
    }
    const runs = await Promise.all(rest.map((path) => readJsonl<RunRow>(path)));
    console.log(renderStability(stability(runs), runs.length));
    break;
  }

  default:
    console.error(`unknown command "${command}"\n${USAGE}`);
    process.exit(1);
}

/**
 * `id=question` for nouls; `id=question|a,b,c` for choices (options) and
 * scores (ordered levels). The id is optional: `question|a,b` gets `q<N>`.
 */
function parseAdHocQuestions(nouls: string[], choices: string[], scores: string[]): Questions {
  const questions: Record<string, Questions[string]> = {};
  let n = 0;
  const split = (spec: string, withList: boolean): { id: string; q: string; list: string[] } => {
    n += 1;
    const [head, listRaw] = withList ? splitLast(spec, '|') : [spec, ''];
    const eq = head.indexOf('=');
    const id = eq > 0 ? head.slice(0, eq).trim() : `q${n}`;
    const q = eq > 0 ? head.slice(eq + 1).trim() : head.trim();
    const list = listRaw
      ? listRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (withList && list.length < 2)
      throw new Error(`"${spec}" needs |a,b,... with at least two entries`);
    return { id, q, list };
  };
  for (const spec of nouls) {
    const { id, q } = split(spec, false);
    questions[id] = noul(q);
  }
  for (const spec of choices) {
    const { id, q, list } = split(spec, true);
    questions[id] = choice(q, Object.fromEntries(list.map((o) => [o, null])));
  }
  for (const spec of scores) {
    const { id, q, list } = split(spec, true);
    questions[id] = score(q, list);
  }
  return questions;
}

function splitLast(s: string, sep: string): [string, string] {
  const i = s.lastIndexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}
