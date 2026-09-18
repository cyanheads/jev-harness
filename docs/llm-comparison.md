# Planned: run an experiment through an LLM for comparison

Not built. Tracked in the repo's issues.

## What

A `--via <model>` flag on `jev run` that sends the same experiment (same `state`, same questions) to a chat model instead of Jev, so two result files can be diffed on the same records: agreement rate per Choice, mean absolute difference per Score and Noul, and cost and latency side by side.

## How it would work

- A second client behind the same `ask(state, questions)` interface. It renders the questions into one structured-output request (a JSON schema with one property per question: an enum for Choice, an integer index for Score, a boolean for Noul) and maps the reply back into the harness's answer shape. Probabilities from an LLM are not calibrated, so `probabilities` and `confidence` would be filled with one-hot values and marked as such in the row.
- OpenRouter already fronts the chat models, so the same key and base URL serve both paths.
- A `jev compare <rows-a.jsonl> <rows-b.jsonl>` command joins two result files on `id` and prints the agreement table.

## Why it is deferred

The harness's job is to make Jev cheap to try. A comparison mode roughly doubles the client surface and adds a schema renderer that has its own failure modes. It earns its place once there is a real experiment whose Jev answers need a reference to be judged against — at that point the first version can be built against that experiment rather than in the abstract.
