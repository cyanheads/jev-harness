# jev-harness

Bun/TypeScript harness for TypeSafe's Jev decision model. An **experiment** (`experiments/<name>.ts`) declares typed questions and a record → `state` mapper; `bun run jev run <name> --input <path>` sends every record to Jev through OpenRouter and writes JSONL rows plus a report to `results/`. Private repo, Claude-maintained; may become a production script.

**Orientation:** this file is the behavioral layer. `README.md` has the command table, env vars, and structure. `docs/jev-prompting.md` is the condensed guide to writing questions; the live TypeSafe docs ([index](https://docs.typesafe.ai/llms.txt)) are the source of truth and every doc page serves Markdown with `.md` appended.

## Stack & gate

Bun ≥1.3, TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`), Zod at the API edge, Biome for lint and format, Bun's native test runner. **Gate: `bun run check`** (typecheck → lint → test → changelog sync). `bun test` and `bun run test` are equivalent here. Zod is the only runtime dependency; don't add the TypeSafe or OpenRouter SDKs — `src/client/jev-client.ts` is the client on purpose (see `docs/decisions.md`).

## Running it

| Mode | Command | Notes |
|:---|:---|:---|
| Payload preview | `bun run jev run <exp> --input <path> --dry-run` | No key needed; prints the first request |
| Run | `bun run jev run <exp> --input <path>` | Needs `OPENROUTER_API_KEY` in `.env`; exit code 2 if any record failed |
| One-off | `bun run jev ask --state "..." --noul "..." --choice "id=q\|a,b"` | Ad-hoc questions, JSON result to stdout |
| List | `bun run jev list` | Experiments under `experiments/` |
| Calibrate | `bun run jev calibrate --rows <rows> --truth <truth>` | Offline; truth lines are `{id, truth: {question: option \| boolean}}` |
| Stability | `bun run jev stability <rows> <rows>...` | Offline; same records sent more than once |

Results land in `results/` (gitignored). The row's `model` field is the versioned ID that answered — log it when comparing runs.

## Architecture

Record → `experiment.state(record)` → `JevClient.ask(state, questions)` → typed answers → `experiment.derive(answers, record)` → JSONL row; `renderReport` tallies the rows.

| Path | Role |
|:---|:---|
| `bin/jev.ts` | CLI (`node:util` `parseArgs`); `run` / `ask` / `list` / `calibrate` / `stability` |
| `src/client/jev-client.ts` | Both providers, retry on 429/5xx honoring `retry-after`, Zod response validation, cost from input tokens |
| `src/questions/questions.ts` | `choice` / `score` / `noul` builders; `AnswersFor<Qs>` infers answer types from the question map |
| `src/experiments/experiment.ts` | `defineExperiment`; `state`/`derive` are method signatures so typed experiments assign to the runner's `Experiment` |
| `src/experiments/load-experiment.ts` | Resolves a path or bare name under `experiments/` |
| `src/input/records.ts` | JSONL / JSON / text / directory / stdin → `{ id, data }` |
| `src/run/runner.ts` | Worker-pool runner; rows stream via `onRow` |
| `src/run/report.ts` | Text report |
| `src/analysis/` | `calibrate` (reliability bins, accuracy, Brier, ECE) and `stability` (largest pairwise difference per question) over rows on disk |

## The rules that matter

- **Questions and thresholds live in the experiment file.** Never scatter them into `src/`. The experiment file is the unit a human reviews.
- **OpenRouter takes strings only** for `instructions` and criteria values, and a Noul `criteria` object must carry both `true` and `false` (one side alone is a 400). `stringifyEntries` JSON-encodes structured entries for that provider and the `NoulQuestion` type requires both sides; TypeSafe direct gets entries raw. Keep that split in the client, not in experiments.
- **Never send the label in the state** when an experiment measures agreement with a carried label (`mcp-error-triage` keeps `errorClass` out of `state` and compares in `derive`).
- **Pinned model by default.** `typesafe/jev-1.13` / `jev-1.13.0`. Don't switch the default to `jev-latest`; thresholds tuned on one version don't carry.
- **Keep the harness thin.** New capability goes in an experiment first; it moves into `src/` only when a second experiment needs it.
- **Rows are the record of a run.** Don't add fields that bloat rows by default — `--keep-input` / `--keep-state` exist for that.
- `.env` is gitignored and holds the only secrets. Never write a key with a file tool; open `.env` in an editor for Casey to paste.
- **A shell-exported `OPENROUTER_API_KEY` wins over `.env`** (Bun does not override variables already in the environment). A stale export in `~/.config/zsh/secrets.zsh` shows up as `401 {"error":{"message":"User not found."}}` on every record even though `.env` is right. Diagnose with `bun -e 'console.log(process.env.OPENROUTER_API_KEY?.slice(-5))'` against the tail of the `.env` value; bypass with `env -u OPENROUTER_API_KEY bun run jev …`; fix by updating the export.

## Where things live

- `docs/decisions.md` — append-only decisions with rationale; add an entry when you change a default.
- `docs/findings.md` — what measurement has shown about Jev (stability, calibration by answer type, which signals held up). Read it before choosing a threshold; update the matching section when a new run supersedes it.
- `docs/jev-prompting.md` — question-writing rules; re-check the live jaggedness page when a new Jev version ships.
- `docs/llm-comparison.md` — the planned `--via <model>` comparison mode, not built.
- `docs/ideas/` — write-ups of experiments worth running later, one file each with status, design, evaluation plan, and kill criteria: `literal-client-probe.md` (Jev as a weak-client reader of MCP tool descriptions), `tool-ranker.md` (Jev as a reranker for tool search). Add a file here when an idea is worth keeping; re-read its open questions before building from one.
- **Issue labels:** `bug` / `enhancement` / `documentation` are for the harness itself; `idea` marks a parked write-up that lives in `docs/ideas/` (one issue per file, body points at the doc); `experiment` marks a concrete run to do — a question, the data, and what result would settle it. An `idea` becomes an `experiment` when someone commits to running it. `duplicate` / `wontfix` for closing.
- `changelog/` — one file per version; `CHANGELOG.md` is generated (`bun run changelog:build`), never hand-edited.
- `samples/` — small synthetic inputs; `results/` — run output, gitignored.

## Triggers

| When the ask is | Do this |
|:---|:---|
| "new experiment for X", "try Jev on X" | Copy `experiments/ticket-routing.ts`, write the `state` mapper for X's record shape, read `docs/jev-prompting.md` before writing questions, `--dry-run` first |
| "run X on this data" | `bun run jev run <exp> --input <path>`; report the printed summary and the two result paths |
| "compare with Claude/GPT" | Not built — `docs/llm-comparison.md` and the tracking issue; don't improvise a chat-completions path |
| "switch to TypeSafe direct" | `JEV_PROVIDER=typesafe` + `TYPESAFE_API_KEY` in `.env`; nothing else changes |
| "new Jev version" | Update `PROVIDERS[*].defaultModel`, re-read the jaggedness page, note it in `docs/decisions.md` and the changelog |

## Commit stance

Standing commit+push grant once `bun run check` is green — this is a Claude-owned private repo. Versioned: a release is a version bump in `package.json` + README badge, a `changelog/<series>/<version>.md` entry, `bun run changelog:build`, commit, annotated `vX.Y.Z` tag, push. No publish pipeline.
