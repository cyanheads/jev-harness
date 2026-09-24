/**
 * experiments/tool-ranking.ts
 *
 * Rank a record's own candidate tools against a request. The Choice options
 * come from the record, so `questions` is a function: each request is asked
 * over its own shortlist, and the option probabilities are the ranking.
 * `derive` reads the rank of the expected tool, which the record carries and
 * the state leaves out. Copy this file when the options differ per record.
 *
 * Sample input: samples/tool-queries.jsonl
 */

import { defineExperiment } from '../src/experiments/index.ts';
import { choice } from '../src/questions/index.ts';

interface Candidate {
  readonly name: string;
  readonly description: string;
}

interface ToolQuery {
  readonly request: string;
  readonly candidates: readonly Candidate[];
  /** The tool that should be called first. Held out of the state. */
  readonly expected: string;
}

export default defineExperiment({
  name: 'tool-ranking',
  description: "Rank a request's candidate tools and report where the expected one lands.",
  questions: (record: ToolQuery) => ({
    tool: choice(
      'Which tool should be called first to handle `request`?',
      Object.fromEntries(record.candidates.map((c) => [c.name, c.description])),
    ),
  }),
  state: (record: ToolQuery) => ({ request: record.request }),
  derive: (answers, record) => {
    const ranked = Object.entries(answers.tool.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const rank = ranked.indexOf(record.expected) + 1;
    if (rank === 0) throw new Error(`expected tool "${record.expected}" is not a candidate`);
    return { rank, hit_at_1: rank === 1, hit_at_3: rank <= 3 };
  },
});
