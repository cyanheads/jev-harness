# Decisions

Append-only. One entry per decision: what, and the one- or two-sentence why.

- **2026-09-17 — Experiments are TypeScript files, not JSON or CLI flags.** The questions are data, but turning an input record into `state` is code (pick fields, drop the label, rename). A TS file with `defineExperiment` keeps both in one place with types; JSON would push the mapping back into hand-prepared data, and flags would make every run a chore.
- **2026-09-17 — Own client instead of `@typesafe-ai/sdk`.** The SDK targets `api.typesafe.ai/v1/systemone`; OpenRouter serves the same body at `/api/alpha/decisions` but validates `instructions`/criteria as strings. A ~150-line fetch client covers both providers, JSON-encodes structured entries for OpenRouter, and keeps the retry and cost accounting visible.
- **2026-09-17 — OpenRouter is the default provider.** TypeSafe's own API is waitlisted; OpenRouter lists `typesafe/jev-1.13` at the same price with no waitlist. `JEV_PROVIDER=typesafe` switches when a direct key exists.
- **2026-09-17 — Default model is the pinned `typesafe/jev-1.13`, not `jev-latest`.** Aliases move when a release ships and change answers under tuned thresholds. The response's `model` field is logged on every row.
- **2026-09-17 — Bun's native test runner, not Vitest.** No config, no dependency, and nothing here uses Vitest-only APIs. `bun test` and `bun run test` are equivalent in this repo.
- **2026-09-17 — Rows stream to JSONL as they complete; the report is computed after.** A long run that dies mid-way still leaves every finished row on disk. Input and state are excluded from rows by default (`--keep-input`, `--keep-state`) to keep result files small.
- **2026-09-17 — `derive` is where policy lives.** Thresholds, agreement with a carried label, and derived decisions are code in the experiment file, tallied in the report. Re-weighting is a code change, not a re-prompt.
- **2026-09-17 — LLM comparison mode is designed but not built.** See `docs/llm-comparison.md`.
- **2026-09-17 — Analysis lives in `src/analysis/`, behind `jev calibrate` and `jev stability`.** Two experiments needed the same reliability tables, which is the bar for moving code out of an experiment file. Both commands read rows from disk and never call Jev, so checking a threshold costs nothing.
- **2026-09-17 — Measured behavior is recorded in `docs/findings.md`, fleet-specific leads are not.** The findings file carries aggregate numbers about how Jev behaves. What a run surfaced about a particular server belongs with that server's issue tracker or the operator's own notes, never in this repo.
- **2026-09-17 — `mcp-error-triage` escalates on summed level probability, and dropped `dx_gap`.** On a real week of errors the top Score level's confidence averaged 0.55, so a confidence gate passed 1% of rows; mass on the top two levels at 0.8 passed 15% and read as a usable queue. `dx_gap` exceeded 0.7 on 58% of input errors and separated nothing.
