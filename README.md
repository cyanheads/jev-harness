<div align="center">
  <h1>jev-harness</h1>
  <p><b>Harness for TypeSafe's Jev decision model: typed questions over datasets via OpenRouter, JSONL answers, summary reports.</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/version-0.1.1-blue?style=flat-square)](./CHANGELOG.md) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh/)

</div>

---

[Jev](https://typesafe.ai) does not generate text. It takes `state` plus typed questions and returns typed answers with probabilities in one parallel pass, at $0.042 per million input tokens. This harness separates the part that stays the same (client, batching, output, report) from the part that changes per experiment (which fields to send, which questions to ask), so trying Jev on a new dataset is one small file and one command.

## Commands

| Command | What it does |
|:---|:---|
| `bun run jev run <experiment> --input <path>` | Run an experiment over every record; write JSONL rows and a report to `results/` |
| `bun run jev ask --state "..." --noul "..."` | One-off question(s) against a string or `@file`, no experiment file needed |
| `bun run jev list` | List experiments under `experiments/` |
| `--dry-run` (on `run` or `ask`) | Print the first request payload and exit without calling Jev |

`run` flags: `--input <path\|->` (JSONL, JSON array, text file, directory, or stdin) · `--out results/` · `--limit N` · `--concurrency 8` · `--model M` · `--provider openrouter\|typesafe` · `--keep-input` · `--keep-state`.

`ask` question flags: `--noul "id=question"` · `--choice "id=question|optA,optB"` · `--score "id=question|level0,level1,level2"`. The `id=` prefix is optional.

## An experiment

```ts
// experiments/ticket-routing.ts
export default defineExperiment({
  name: 'ticket-routing',
  description: 'Route a support ticket to a team and flag refund requests.',
  questions: {
    team: choice('Which team should handle this ticket?', {
      billing: 'Payments, invoices, refunds, subscriptions',
      technical: 'Bugs, errors, integrations, outages',
      other: 'Anything the teams above do not cover',
    }),
    frustration: score('How frustrated does the customer appear?', ['Calm', 'Frustrated but civil', 'Very angry']),
    refund_requested: noul('The customer explicitly asks for a refund or credit.'),
  },
  state: (record: Ticket) => ({ subject: record.subject, body: record.body }),
  derive: (answers) => ({ route: answers.team.confidence < 0.5 ? 'human' : answers.team.choice }),
});
```

`questions` are asked together over each record's `state`. `derive` is optional code-side policy (thresholds, agreement with a label on the record); its fields land in each row and are tallied in the report. Answer types follow the questions: `answers.team.choice` is typed to the declared option keys.

Two experiments ship: `ticket-routing` (the smallest possible one; copy it) and `mcp-error-triage` (classifies hosted MCP server errors by origin, severity, and error-message clarity). Sample inputs for both are in `samples/`.

## Getting started

```bash
bun install
cp .env.example .env            # add OPENROUTER_API_KEY
bun run jev run ticket-routing --input samples/tickets.jsonl --dry-run   # payload preview, no key needed
bun run jev run ticket-routing --input samples/tickets.jsonl
```

## Configuration

| Variable | Required | Default | What it does |
|:---|:---|:---|:---|
| `JEV_PROVIDER` | no | `openrouter` | `openrouter` calls `openrouter.ai/api/alpha/decisions`; `typesafe` calls `api.typesafe.ai/v1/systemone` |
| `OPENROUTER_API_KEY` | with `openrouter` | — | OpenRouter key |
| `TYPESAFE_API_KEY` | with `typesafe` | — | TypeSafe key (early access) |
| `JEV_MODEL` | no | `typesafe/jev-1.13` / `jev-1.13.0` | Model ID. Pinned by default; aliases like `jev-latest` move when a release ships |

A variable already exported in the shell takes precedence over `.env`. If every record fails with `401 User not found` while `.env` holds a valid key, a stale export is shadowing it: `env -u OPENROUTER_API_KEY bun run jev …` bypasses it.

## Output

Each `run` writes `results/<experiment>-<timestamp>.jsonl` (one row per record: `id`, `answers`, `derived`, `model`, `usage`, `costUsd`, `latencyMs`, `attempts`) and a `.report.txt` with per-question distributions, confidence, latency percentiles, token count and cost, and tallies of `derived` fields. Rows stream to disk as they complete.

## Project structure

| Path | Purpose |
|:---|:---|
| `bin/jev.ts` | The CLI |
| `src/client/` | HTTP client for both providers: retries, response validation, cost and latency per call |
| `src/questions/` | `choice` / `score` / `noul` builders, wire schemas, answer-type inference |
| `src/experiments/` | `defineExperiment`, experiment loader |
| `src/input/` | Input path → records (JSONL, JSON, text, directory, stdin) |
| `src/run/` | Concurrency-bounded runner, report renderer |
| `experiments/` | One file per experiment |
| `samples/` | Small inputs for the shipped experiments |
| `docs/` | `jev-prompting.md` (how to write questions), `decisions.md`, `llm-comparison.md` (planned), `ideas/` (unbuilt experiment write-ups) |

## Development guide

- `bun run check` is the gate: typecheck, Biome lint/format, tests, changelog sync.
- Questions and thresholds live in the experiment file, nowhere else — that is the part a reviewer reads.
- Read `docs/jev-prompting.md` before writing questions; the live TypeSafe docs are the source of truth.
- Working rules for agents: `CLAUDE.md`.

## Contributing

```bash
bun run check
```

## License

Private.
