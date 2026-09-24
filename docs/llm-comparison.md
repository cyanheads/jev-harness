# Planned: run an experiment through an LLM for comparison

The `--via` half is not built; the diff half is `jev compare`. Tracked in [#1](https://github.com/cyanheads/jev-harness/issues/1).

## What

A `--via <model>` flag on `jev run` that sends the same experiment (same `state`, same questions) to a chat model instead of Jev, so the two result files can be diffed with `jev compare` on the same records: which records changed their answer per question, the mean shift per Score and Noul, and, from the two reports, cost and latency side by side.

## How it would work

- A second client behind the same `ask(state, questions)` interface. It renders the questions into one structured-output request (a JSON schema with one property per question: an enum for Choice, an integer index for Score, a boolean for Noul) and maps the reply back into the harness's answer shape. Probabilities from an LLM are not calibrated, so `probabilities` and `confidence` would be filled with one-hot values and marked as such in the row.
- OpenRouter already fronts the chat models, so the same key and base URL serve both paths.
- `jev compare <rows-a.jsonl> <rows-b.jsonl>` already joins two result files on `id` and prints the per-question changes; a one-hot LLM answer compares like any other.

## Why it is deferred

The harness's job is to make Jev cheap to try. A comparison mode roughly doubles the client surface and adds a schema renderer that has its own failure modes. It earns its place once there is a real experiment whose Jev answers need a reference to be judged against — at that point the first version can be built against that experiment rather than in the abstract.
