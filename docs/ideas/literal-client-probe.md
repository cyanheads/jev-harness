# Literal-client probe for MCP tool descriptions

**Status:** parked idea, nothing built. The plain form probably tells us little; the variants under "Where the signal might be" are why it is kept.

## The idea

An MCP server's tool names, descriptions, and `.describe()` strings are the whole interface a model gets. Jev reads literally and does not reason its way around ambiguity, which makes it a cheap stand-in for a weak client. Give it a server's tool surface and a user intent, ask which tool it would call, and treat wrong or low-margin picks as evidence that the descriptions collide.

```ts
// one request per intent
state: { intent: "find stream gauges near Boulder and get last week's flow" }
questions: {
  tool: choice("Which tool should be called first to satisfy `intent`?", {
    water_find_sites: "<tool description, verbatim>",
    water_get_readings: "<tool description, verbatim>",
    // … every tool on the server, plus:
    none: "No tool on this server fits.",
  }),
}
```

Output per server: a confusion matrix (intended tool × picked tool) and, per intent, the probability margin between the top two options.

A second level asks about parameters: given the chosen tool's input schema, a Choice over an enum field's values ("which `operation` fits this intent?"), or a Noul per optional parameter ("the intent requires setting `classification`").

## Why the plain form may be thin

- **Circular intents.** If a model writes the test intents from the tool descriptions, each intent paraphrases its target and routing is trivially right. The probe only measures something when intents come from a source independent of the descriptions: the upstream API's own docs and FAQ, real task phrasing, questions from the domain's forums, or the patterns behind input errors. That sourcing is most of the work.
- **Jev is not the client.** Real callers are frontier models that read the schema, reason, and recover from a wrong first call. A collision Jev trips on may never matter in practice, so every hit needs a second look before it becomes an issue. The probe ranks where to look; it does not find defects by itself.
- **Static lint already covers the mechanical cases.** A description that names a nonexistent enum value, or an ID field that never says where the ID comes from, is caught by reading the definition (`lint:mcp`, the DX-analysis checklist). The probe adds nothing there.
- **Most servers are small.** Five to ten tools with distinct verbs rarely collide. The expected yield is concentrated in servers with overlapping search/list/get families and in multi-server installs.

## Where the signal might be

1. **A regression metric for description edits.** The probabilities make a description change measurable: run a fixed intent set before and after an edit and compare the margin on each intent. "This rewrite dropped the margin between `search` and `find` from 0.6 to 0.1" is a number no current gate produces. The intent set is written once per server and reused, which also amortizes the sourcing cost above.
2. **Sentence ablation.** Remove one sentence from a description and re-run. Sentences whose removal changes nothing carry no routing weight and are candidates to cut; the ones that swing the margin are load-bearing and should not be reworded casually.
3. **Cross-server collisions.** With several servers installed at once (weather: `nws-weather`, `open-meteo`, `noaa-climate`; literature: `pubmed`, `openalex`, `crossref`), which server does a query route to, and is that the right one? This is the same measurement as the tool ranker in [`tool-ranker.md`](tool-ranker.md) read the other way: low margin between two servers' tools is a description problem.
4. **Enum and mode selection.** Tools that multiplex behavior behind an `operation` or `mode` enum are where literal readers go wrong most. A Choice over the enum values, with each value's described meaning as its criteria, tests whether the value names and descriptions separate cleanly.

## Smallest experiment that answers "is there anything here"

1. Pick three servers with known description-driven issues already filed (so ground truth exists) and one multi-server cluster.
2. Write 20 to 30 intents per server from sources other than the tool descriptions. Label the intended tool by hand.
3. Run the Choice probe. Record accuracy, the margin distribution, and every wrong or sub-0.2-margin pick.
4. Check the hits against the filed issues: does the probe rediscover the known problems, and does it surface anything new that survives a human read?
5. Repeat step 3 after applying one known description fix. If the margin does not move, variant 1 is dead too.

Kill criteria: the probe rediscovers none of the known issues, or every new hit is a false positive on review.

## If it proves out

A development script in `mcp-ts-core` (working name `probe:descriptions`), run on demand, never inside `devcheck`: it needs a paid API key, makes network calls, and its output is advisory. It would discover definitions the way `lint:mcp` does, read a per-server `tests/intents.jsonl`, call Jev through this harness, and print the confusion matrix and the margin diff against a stored baseline. This repo is public but not on npm, so the script would link it with `bun link`; it also needs an intent-file convention servers can adopt gradually. Inside this harness, the probe is one experiment whose Choice options are built from each record's tool list, like `experiments/tool-ranking.ts`.

## Open questions

- How many options and how much description text a Choice question tolerates before accuracy drops (context rot), which bounds how large a server can be probed in one request.
- Whether Jev's margins are stable enough run to run to serve as a regression metric, or need averaging.
- Whether a frontier model given the same probe disagrees with Jev often enough that Jev-only hits are mostly noise. The planned comparison mode ([`llm-comparison.md`](llm-comparison.md)) would answer this.
- Where intents come from at fleet scale without being circular.

## Decisions

- **Parked, not scheduled.** The plain confusion matrix is unlikely to beat reading the definitions. The idea is kept for the margin-as-metric and ablation variants, which have no existing equivalent.
- **Never a gate.** Any shipped form is an on-demand advisory script: a paid external model must not sit in the path of `devcheck`.
