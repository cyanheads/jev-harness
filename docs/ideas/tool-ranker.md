# Jev as a tool search ranker

**Status:** idea, nothing built. Worth an experiment: the baseline exists, the evaluation is cheap, and the result is a yes or no.

## The problem

A client with more tools than fit in context loads them on demand: something takes a query (or the conversation) and returns the N tools most likely to be relevant. The ranking step decides whether the right tool is ever seen.

`cyanheads-mcp-server` is a concrete instance. Its `cyanheads_search_catalog` embeds the query at runtime (`Snowflake/snowflake-arctic-embed-m-v1.5`, with a query prefix) and ranks by cosine similarity against vectors baked into `fleet.json`, one per tool over `displayName + "\n" + description` and one per server, with a minimum-similarity floor and a cap of 20 results. That is a bi-encoder: query and tool are embedded separately and never read together.

## What Jev could add

Jev reads the query and every candidate in the same pass and returns a probability per option, which is what a cross-encoder reranker does, with three differences that matter here:

- **Structured options.** Each option can carry more than a description: what the tool is for, what it is *not* for, the server it belongs to, required inputs, and whether it needs an ID from another tool. Embeddings flatten all of that into one vector.
- **Conversation as state.** The state can hold the latest user message, the last few turns, and the tools already called, so "now get the full text" resolves against the search the user just ran. A single-query embedding cannot use that.
- **A distribution, not a list.** The probabilities give a calibrated cut: return three tools when the mass is concentrated, ten when it is flat, and "nothing fits" when the `none` option wins. The embedding path needs a hand-tuned similarity floor for the same job.

```ts
state: {
  latest_user_message: "...",
  recent_turns: ["...", "..."],
  tools_already_called: ["pubmed_search_articles"],
}
questions: {
  tool: choice(
    { question: "Which tool best serves `latest_user_message`?", focus: "Use `recent_turns` only to resolve references." },
    {
      pubmed_fetch_fulltext: { server: "pubmed-mcp-server", what: "...", not_for: "...", needs: "a PMCID or PMID from a search" },
      // … up to 254 more
      none: "No listed tool fits.",
    },
  ),
}
```

## Designs, in the order worth trying

| Design | How | Trade-off |
|:---|:---|:---|
| **A. Rerank** | Embeddings pick the top 50 to 250; Jev reorders them and sets the cut | Smallest change, keeps the offline index, bounded cost. Cannot recover a tool the embedding stage dropped |
| **B. Two-stage** | Choice over servers (the fleet fits in one question), then Choice over the winning servers' tools | No embedding dependency. A wrong first stage is unrecoverable, so take the top few servers, not one |
| **C. Sharded single request** | Several Choice questions in one request, each over a shard of at most 254 tools plus `none` | One round trip over the whole catalog. Probabilities are normalized per shard, so cross-shard ordering leans on each shard's `none` mass and may not be comparable |
| **D. Noul per tool** | One "this tool is relevant" question per candidate | Independent, directly comparable scores and natural multi-label output. Only viable if the per-request question limit allows hundreds |

A is the experiment. B through D are only interesting if A shows Jev ranks better than cosine on the candidates it is given.

## Evaluation

1. Build a labeled set: 150 to 300 queries, each with the tool or tools that should surface. Mix single-turn queries with multi-turn ones where the last message is only resolvable from context. Write queries from the user's side, not from the descriptions.
2. Baseline: the current embedding ranking. Record recall@1/3/5/10 and MRR.
3. Design A on the same set, with and without the structured option fields, and with and without conversation state, so each addition's contribution is separable.
4. Also record latency per query, input tokens, and cost. A 250-option request with full descriptions is on the order of tens of thousands of input tokens, a fraction of a cent at current pricing, but the latency at that size is unmeasured.
5. Look at the failures by hand. If Jev's misses are different from the embedding's misses, a blend may beat both.

The experiment fits this harness as it stands: one experiment file, the labeled set as JSONL, `derive` computing rank of the expected tool, and the report tallying recall.

## Where it could ship

- **`cyanheads_search_catalog`**: an optional rerank stage behind a config flag, falling back to cosine order when the key is absent or the call fails.
- **A general tool-search server**: a gateway that fronts any set of MCP servers, indexes their `tools/list` output, and exposes one `search_tools` call. This is the general form of what deferred-tool clients do internally with name and keyword matching, and it is where conversation-aware ranking would be most visible.
- **A framework utility** in `mcp-ts-core` for servers with very large tool or dataset surfaces that want in-server routing.

## Risks and open questions

- **An external paid model in a hot path.** Every search would send the user's query, and in the conversation-aware form recent turns, to OpenRouter and TypeSafe. That is a latency, availability, and privacy change for a hosted public endpoint, and it needs a clear fallback and a clear disclosure. The rerank stage must be optional.
- **Option-count and option-length limits.** 255 options is the documented ceiling; how accuracy degrades as options and description length grow is unknown and decides between designs A and C.
- **Per-request question limit**, which decides whether design D is possible.
- **Whether the static option block is cached upstream.** If not, every query pays for the full catalog text again.
- **Calibration.** The adaptive cut only works if the probabilities mean something; an issue-labeling run over several hundred GitHub issues suggested type Choices are well behaved and some Noul flags are overconfident. Check calibration on the labeled set before relying on the distribution.
- **Model pinning.** A ranker tuned on one Jev version needs re-evaluation on the next; keep the labeled set as the regression suite.

## Decisions

- **Rerank first.** Design A isolates the question "does Jev rank better than cosine" from every engineering question, and it is the only design with a safe fallback.
- **Measure before building.** No integration work in any server until the labeled-set comparison shows a recall gain large enough to justify an external dependency in the search path.
