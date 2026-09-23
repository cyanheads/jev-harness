/**
 * src/input/records.ts
 *
 * Turn an input path into records. Accepted inputs: a `.jsonl` file (one JSON
 * value per line), a `.json` file (an array, or one object), a text file (one
 * record, `{ text }`), a directory (one record per file, `{ path, text }` or the
 * parsed JSON), or `-` for stdin (JSONL if multi-line, else JSON).
 *
 * Every record gets an `id`: its own `id` / `requestId` when present, the file
 * name for directory inputs, else its zero-based index. Ids must be unique
 * within one input.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export interface Record_ {
  readonly id: string;
  readonly data: unknown;
}

/** Rows are joined on `id` by `calibrate`, `stability`, and downstream readers, so a repeat is an error. */
export async function loadRecords(input: string): Promise<Record_[]> {
  const records = await readRecords(input);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of records) (seen.has(id) ? repeated : seen).add(id);
  if (repeated.size > 0) {
    throw new Error(
      `${input} has ${repeated.size} repeated record id(s): ${[...repeated].slice(0, 5).join(', ')}`,
    );
  }
  return records;
}

async function readRecords(input: string): Promise<Record_[]> {
  if (input === '-') return fromText(await Bun.stdin.text(), 'stdin');
  const info = await stat(input);
  if (info.isDirectory()) {
    const names = (await readdir(input)).filter((n) => !n.startsWith('.')).sort();
    const records: Record_[] = [];
    for (const name of names) {
      const path = join(input, name);
      if (!(await stat(path)).isFile()) continue;
      const text = await readFile(path, 'utf8');
      const data = extname(name) === '.json' ? parseJson(text, path) : { path, text };
      records.push({ id: basename(name, extname(name)), data });
    }
    return records;
  }
  const text = await readFile(input, 'utf8');
  const ext = extname(input);
  if (ext === '.jsonl' || ext === '.ndjson') return parseJsonl(text, input).map(withId);
  if (ext === '.json') return fromJson(parseJson(text, input));
  return [{ id: basename(input, ext), data: { text } }];
}

function fromText(text: string, label: string): Record_[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return fromJson(JSON.parse(trimmed));
    } catch {
      // multi-line JSONL that happens to start with an object — fall through
    }
  }
  if (trimmed.length === 0) throw new Error(`${label} is empty`);
  return parseJsonl(text, label).map(withId);
}

/** A JSONL file's values in order, blank lines skipped. A bad line is named by path and line number. */
export async function readJsonl(path: string): Promise<unknown[]> {
  return parseJsonl(await readFile(path, 'utf8'), path);
}

function parseJsonl(text: string, label: string): unknown[] {
  const values: unknown[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line.length > 0) values.push(parseJson(line, `${label}:${i + 1}`));
  }
  return values;
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fromJson(value: unknown): Record_[] {
  return Array.isArray(value) ? value.map(withId) : [withId(value, 0)];
}

function withId(data: unknown, index: number): Record_ {
  if (typeof data === 'object' && data !== null) {
    const { id, requestId } = data as { id?: unknown; requestId?: unknown };
    const own = id ?? requestId;
    if (typeof own === 'string' || typeof own === 'number') return { id: String(own), data };
  }
  return { id: String(index), data };
}
