# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-09-23

Questions built per record, `jev compare` for before/after runs, a threshold sweep and Score scoring in `calibrate`, and `--resume` for an interrupted run.

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-09-23

Licensed under Apache-2.0.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-09-23

`null` is typed out of instructions, Score levels, and Noul sides, where OpenRouter rejects it; the client no longer sends a null there as the string "null".

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-09-23

A blank retry-after no longer retries at once, `jev ask` rejects repeated question ids and options, and the report labels structured Score levels as JSON.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-09-23

A throwing sink stops the run instead of letting workers keep calling Jev, parse errors name the file and line, and repeated runs no longer share an output file.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-09-18 · ⚠️ Breaking

CLI flags are validated, `--dry-run` previews the provider the real call would use, repeated record ids are rejected, and `calibrate` reports the truth values it could not score.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-09-18

`mcp-error-triage` judges clarity on the message plus the recovery hint the caller was shown, and holds a `server` disagreement to 0.75.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-09-17 · ⚠️ Breaking

`mcp-error-triage` reworked into a two-question second reader; runs stop at the first rejected key and retry timeouts.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-09-17

Offline analysis commands: `jev calibrate` checks probabilities against known answers, `jev stability` compares repeated runs. First measured findings recorded.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-17

Linkable package exports; Noul criteria require both sides (OpenRouter rejects one-sided criteria).

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-09-17

Initial harness: Jev client for OpenRouter and TypeSafe, typed Choice/Score/Noul builders, experiment files, JSONL runner with report, two sample experiments.
