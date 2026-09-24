<div align="center">
  <h1>jev-harness</h1>
  <p><b>Harness for TypeSafe's Jev decision model: typed questions over datasets via OpenRouter, JSONL answers, summary reports.</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/version-0.5.0-blue?style=flat-square)](./CHANGELOG.md) [![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh/)

</div>

---

[Jev](https://typesafe.ai) is a decision model from TypeSafe. It does not generate text. You send it `state` (a string or JSON) and a set of typed questions, and it answers all of them in one pass. Every answer stays inside the schema you declared and comes back with probabilities.

This harness runs Jev over a dataset. An **experiment** is one TypeScript file that says which fields of each record to send and which questions to ask. `bun run jev run <experiment> --input <file>` sends every record, streams one JSONL row per record to `results/`, and prints a summary report. Three offline commands check the answers: `calibrate` against known labels, `stability` across repeated runs, and `compare` between a run before and after a change.

## Quick start

Requires [Bun](https://bun.sh/) 1.3 or later and an [OpenRouter key](https://openrouter.ai/keys).

```bash
git clone https://github.com/cyanheads/jev-harness.git
cd jev-harness
bun install
cp .env.example .env    # then set OPENROUTER_API_KEY

# Print the request the first record would send. No key needed; nothing is called.
bun run jev run ticket-routing --input samples/tickets.jsonl --dry-run

# Send all five sample tickets.
bun run jev run ticket-routing --input samples/tickets.jsonl
```

Run commands from the repository root, since Bun loads `.env` from the current directory.

## Question types

| Type | Builder | Asks | Answer fields |
|:---|:---|:---|:---|
| Choice | `choice(instructions, { key: description, ... })` | Which option applies? 1–255 options | `choice` (the picked key), `probabilities` per option, `confidence` |
| Score | `score(instructions, [level0, level1, ...])` | How much? 2–10 ordered levels | `score` (probability-weighted position, can fall between levels), `probabilities`, `confidence` |
| Noul | `noul(instructions, { true, false }?)` | Does this hold? | `noul`, the probability of yes |

Instructions, option descriptions, and levels can be plain strings or structured JSON such as `{ what, examples }`. [`docs/jev-prompting.md`](./docs/jev-prompting.md) covers how to write questions Jev answers well.

## Writing an experiment

This is [`experiments/ticket-routing.ts`](./experiments/ticket-routing.ts), the smallest shipped experiment. Copy it to start a new one.

```ts
import { defineExperiment } from '../src/experiments/index.ts';
import { choice, noul, score } from '../src/questions/index.ts';

interface Ticket {
  readonly subject: string;
  readonly body: string;
}

export default defineExperiment({
  name: 'ticket-routing',
  description: 'Route a support ticket to a team and flag refund requests.',
  questions: {
    team: choice('Which team should handle this ticket?', {
      billing: 'Payments, invoices, refunds, subscriptions',
      technical: 'Bugs, errors, integrations, outages',
      sales: 'Pricing, plans, upgrades, new accounts',
      other: 'Anything the three teams above do not cover',
    }),
    frustration: score('How frustrated does the customer appear?', [
      'Calm, just stating facts',
      'Frustrated but civil',
      'Very angry, strong language',
    ]),
    refund_requested: noul('The customer explicitly asks for a refund or credit.'),
  },
  state: (record: Ticket) => ({ subject: record.subject, body: record.body }),
  derive: (answers) => ({
    route: answers.team.confidence < 0.5 ? 'human' : answers.team.choice,
    refund_flow: answers.refund_requested.noul > 0.7 && answers.team.choice === 'billing',
  }),
});
```

- `questions` are asked together over each record's state.
- `state` maps one input record to what Jev sees. Send only the fields the questions need, and leave out any label you are measuring against.
- `derive` is optional. It holds code-side policy, such as thresholds or a comparison with a label the record carries. Its fields are written to each row under `derived` and tallied in the report.
- Answer types follow the questions: `answers.team.choice` is typed `'billing' | 'technical' | 'sales' | 'other'`.

When the options differ per record, make `questions` a function of the record. [`experiments/tool-ranking.ts`](./experiments/tool-ranking.ts) asks each request which of its own candidate tools to call first, and reads the option probabilities as a ranking:

```ts
questions: (record: ToolQuery) => ({
  tool: choice(
    'Which tool should be called first to handle `request`?',
    Object.fromEntries(record.candidates.map((c) => [c.name, c.description])),
  ),
}),
```

The repo also ships `mcp-error-triage`. It reads MCP server tool errors and asks two things: who caused the error, compared in `derive` with a rule-based label the record carries, and whether the text shown to the caller explains what went wrong. Sample inputs for all three experiments are in `samples/`.

## Commands

Run each as `bun run jev <command>`.

| Command | What it does |
|:---|:---|
| `run <experiment> --input <path>` | Run an experiment over every record; write rows and a report to `results/` |
| `ask --state <text\|@file> --noul "..."` | Ask one-off questions without an experiment file; print the result as JSON |
| `list` | List the experiments in `experiments/` |
| `calibrate --rows <rows.jsonl> --truth <truth.jsonl>` | Score a run's answers against known answers. Offline |
| `stability <rows.jsonl> <rows.jsonl>...` | Measure run-to-run noise across two or more identical runs. Offline |
| `compare <before.jsonl> <after.jsonl>` | Show what changed between two runs over the same records. Offline |

`<experiment>` is a name under `experiments/` or a path to a `.ts` file.

### `run`

| Flag | Default | Meaning |
|:---|:---|:---|
| `--input`, `-i` | required | `.jsonl` or `.ndjson`, a `.json` array or object, any other file as one `{ text }` record, a directory (one record per file), or `-` for stdin |
| `--out`, `-o` | `results` | Output directory |
| `--limit` | all records | Send only the first N records |
| `--concurrency` | `8` | Requests in flight |
| `--model` | see [Configuration](#configuration) | Model ID for this run |
| `--provider` | `JEV_PROVIDER`, else `openrouter` | `openrouter` or `typesafe` |
| `--keep-input` | off | Copy each input record into its row |
| `--keep-state` | off | Copy the state sent to Jev into each row |
| `--resume` | none | An earlier run's rows file: send only the records it lacks, append to it, and rewrite its report over all rows |
| `--dry-run` | off | Print the first request body for the provider and model the real call would use, then exit |

A record's id is its own `id` or `requestId` field, the file name for directory inputs, or otherwise its zero-based position. Ids must be unique within an input because `calibrate` and `stability` join rows on them.

Each row is on disk as soon as its record finishes, so a run that dies partway can be finished with `--resume`, which also retries the records that failed. Requests are retried on 408, 429, and 5xx responses, timeouts, and dropped connections, up to four attempts, honoring `retry-after` for up to a minute. Exit codes: `0` when every record succeeded, `2` when any record failed, and `1` when the key was rejected (the run stops at the first 401 or 403) or on any other error.

### `ask`

Each question flag can be repeated. The `id=` prefix is optional; without it, ids are generated (`q1`, `q2`, ...).

| Flag | Format |
|:---|:---|
| `--noul` | `"id=question"` |
| `--choice` | `"id=question\|optA,optB"` |
| `--score` | `"id=question\|level0,level1,level2"` |

`--state @path` reads the state from a file. `--provider`, `--model`, and `--dry-run` work as they do on `run`.

### `calibrate`, `stability`, and `compare`

`calibrate` takes a truth file with one JSON line per record: an option key for a Choice, a level index for a Score, a boolean for a Noul.

```json
{"id": "t1", "truth": {"team": "billing", "frustration": 0, "refund_requested": true}}
```

For each question it prints reliability bins (`--bins`, default 10), accuracy, Brier score, and expected calibration error; a Score also gets the mean distance between its weighted score and the true level. For a Choice or Score, the bins and calibration error grade `confidence` against whether the picked option (the most probable level) was right, and the Brier score grades the per-option probabilities. Below the bins, a threshold sweep shows what acting only at or above each cutoff would do. For a Choice or Score that is the share of rows kept, their accuracy, and the share of correct answers kept. For a Noul it is the share flagged, the precision among them, and the recall. Truth values it cannot score (a question the rows lack, the wrong kind of value, an undeclared option or level) are counted per question below the tables.

`stability` takes the rows of two or more identical runs over the same records. For each question it prints the mean and maximum of each record's largest run-to-run difference, the number of records that moved by more than 0.05, and, for a Choice, how many records changed their picked option.

`compare` takes a run before and after a change (a reworded question, a new model, a different state mapper) and joins them on record id. For each question it counts the records whose answer changed: a different pick for a Choice, a different rounded level for a Score, a crossing of 0.5 for a Noul. A Noul or Score also gets its mean shift from before to after. It then lists the changed records, largest difference first, and names any question only one run asked.

## Output

Each `run` writes two files to `--out`:

- `<experiment>-<timestamp>.jsonl` has one row per record, written as each completes. Fields: `id`, `experiment`, `model`, `answers`, `derived` (when the experiment has `derive`), `usage` (`inputTokens`, `outputTokens`), `costUsd`, `latencyMs`, `attempts`, plus `input` and `state` when kept.
- `<experiment>-<timestamp>.report.txt` holds the report also printed to stdout: the answering model, latency p50/p95/max, input tokens and cost, then per question the option shares and confidence (Choice), the mean score and level shares (Score), or the mean probability and the shares above 0.5 and between 0.35 and 0.65 (Noul), and a tally of every `derived` field. Over 20 rows or more, a question gets a `!` note when one option or level takes 90% of rows, or a Noul is above 0.5 on 75%. A question that rarely changes its answer separates little.

A row's `model` is the versioned ID that answered, so record it when comparing runs. Cost is computed from input tokens at the listed $0.042 per million.

## Configuration

Set these in `.env` (see [`.env.example`](./.env.example)) or in the environment.

| Variable | Default | Purpose |
|:---|:---|:---|
| `JEV_PROVIDER` | `openrouter` | `openrouter` calls `openrouter.ai/api/alpha/decisions`; `typesafe` calls TypeSafe's API at `api.typesafe.ai/v1/systemone` |
| `OPENROUTER_API_KEY` | none | Required with `openrouter` |
| `TYPESAFE_API_KEY` | none | Required with `typesafe`. TypeSafe's API is in early access |
| `JEV_MODEL` | `typesafe/jev-1.13` (OpenRouter), `jev-1.13.0` (TypeSafe) | Model ID |

Both providers take the same request body, except that OpenRouter requires strings for instructions and criteria values. The client JSON-encodes structured entries when sending to OpenRouter and passes them through unchanged to TypeSafe.

The default model is pinned on purpose. An alias such as `jev-latest` moves when a new version ships, and thresholds tuned on one version don't carry over to the next.

A variable exported in your shell takes precedence over `.env`. If a run stops with `401 User not found` while `.env` holds a valid key, a stale export is the likely cause; `env -u OPENROUTER_API_KEY bun run jev ...` bypasses it.

## Measured behavior

[`docs/findings.md`](./docs/findings.md) records what runs of `typesafe/jev-1.13-20260917` through OpenRouter have shown, with the data and method behind each result. Three of them:

- 120 GitHub issues were each sent three times. "No Choice changed its selected option across the three runs," and the mean largest difference in a Choice's option probabilities was 0.005.
- A five-option Choice over 712 issues with maintainer-assigned type labels scored "Top-1 accuracy 97.9%, expected calibration error 0.039." Rows with confidence between 0.6 and 0.7 were right 96% of the time.
- Five Noul flags scored against issue labels: "The ordering is sound and the magnitudes are not: a Noul works as a screen and as a ranking, not as a trigger."

## Using it as a library

`src/index.ts` exports the client, question builders, runner, and analysis functions, and each module has a subpath: `jev-harness/client`, `/questions`, `/experiments`, `/input`, `/run`, `/analysis`. The package is not published to npm. Run `bun link` in this repo, then `bun link jev-harness` in yours.

```ts
import { choice, JevClient, noul } from 'jev-harness';

// Reads JEV_PROVIDER, JEV_MODEL, and the provider's key from the environment.
const jev = new JevClient();

const result = await jev.ask('I was charged twice for order A-104. Please refund one.', {
  team: choice('Which team should handle this ticket?', { billing: null, technical: null, other: null }),
  refund: noul('The customer asks for a refund.'),
});

result.answers.team.choice; // 'billing' | 'technical' | 'other'
result.answers.refund.noul; // probability of yes
```

## Project layout

| Path | Contents |
|:---|:---|
| `bin/jev.ts` | The CLI |
| `src/client/` | HTTP client for both providers: retries, response validation, cost and latency per call |
| `src/questions/` | `choice` / `score` / `noul` builders, wire schemas, answer-type inference |
| `src/experiments/` | `defineExperiment` and the experiment loader |
| `src/input/` | Input path to records |
| `src/run/` | Concurrency-bounded runner and report |
| `src/analysis/` | `calibrate`, `stability`, and `compare` |
| `experiments/` | One file per experiment |
| `samples/` | Small synthetic inputs for the shipped experiments |
| `docs/` | [`jev-prompting.md`](./docs/jev-prompting.md) (writing questions), [`findings.md`](./docs/findings.md) (measured behavior), [`decisions.md`](./docs/decisions.md) (design decisions and why), [`llm-comparison.md`](./docs/llm-comparison.md) (a planned mode that runs the same experiment through a chat model; not built), `ideas/` (experiments not yet run) |

## Development

```bash
bun run check    # typecheck, Biome lint and format check, tests, changelog sync
```

Questions and thresholds belong in the experiment file, not in `src/`, because that file is what a reviewer reads. Each release adds a file under `changelog/`, and `bun run changelog:build` generates `CHANGELOG.md` from them. Working rules for coding agents are in [`CLAUDE.md`](./CLAUDE.md).

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
