import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecords } from './index.ts';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jev-records-'));
}

describe('loadRecords', () => {
  test('jsonl: one record per line, id from the record when present', async () => {
    const dir = await scratch();
    const path = join(dir, 'in.jsonl');
    await writeFile(path, '{"id":"a","x":1}\n\n{"requestId":"r2","x":2}\n{"x":3}\n');
    const records = await loadRecords(path);
    expect(records.map((r) => r.id)).toEqual(['a', 'r2', '2']);
  });

  test('json: array or single object', async () => {
    const dir = await scratch();
    const arr = join(dir, 'arr.json');
    await writeFile(arr, '[{"x":1},{"x":2}]');
    expect((await loadRecords(arr)).map((r) => r.id)).toEqual(['0', '1']);
    const one = join(dir, 'one.json');
    await writeFile(one, '{"id":7,"x":1}');
    expect((await loadRecords(one))[0]?.id).toBe('7');
  });

  test('rejects an input whose ids repeat', async () => {
    const dir = await scratch();
    const path = join(dir, 'dup.jsonl');
    await writeFile(path, '{"id":"a"}\n{"id":"b"}\n{"id":"a"}\n');
    await expect(loadRecords(path)).rejects.toThrow(/1 repeated record id\(s\): a/);
  });

  test('names the file and line of a line that is not JSON', async () => {
    const dir = await scratch();
    const path = join(dir, 'cut.jsonl');
    await writeFile(path, '{"id":"a"}\n\n{"id":"b","x":');
    await expect(loadRecords(path)).rejects.toThrow(`${path}:3: `);
  });

  test('text file: a single { text } record', async () => {
    const dir = await scratch();
    const path = join(dir, 'note.md');
    await writeFile(path, 'hello');
    expect(await loadRecords(path)).toEqual([{ id: 'note', data: { text: 'hello' } }]);
  });

  test('directory: one record per file, json parsed, others as text', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'b.txt'), 'bee');
    await writeFile(join(dir, 'a.json'), '{"k":1}');
    await writeFile(join(dir, '.hidden'), 'x');
    const records = await loadRecords(dir);
    expect(records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(records[0]?.data).toEqual({ k: 1 });
    expect(records[1]?.data).toMatchObject({ text: 'bee' });
  });
});
