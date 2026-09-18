# Jev as a tool search ranker

**Status:** idea, nothing built. As a serving-path feature for a catalog of a few hundred tools it is over-engineering. It is kept for two reasons: Jev is a cheap offline instrument for measuring how good tool search could be, and the serving-path form becomes reasonable under conditions listed at the end.

## The problem

A client with more tools than fit in context loads them on demand: something takes a query and returns the N tools most likely to be relevant. The ranking step decides whether the right tool is ever seen.

Two styles exist today. Agent harnesses that defer tool loading mostly search lexically (exact name, regex, BM25) and rely on the model to write a good query and retry. `cyanheads-mcp-server` goes a step further: `cyanheads_search_catalog` embeds the query at runtime (`Snowflake/snowflake-arctic-embed-m-v1.5`, with a query prefix) and ranks by cosine similarity against vectors baked into `fleet.json`, one per tool over `displayName + "\n" + description` and one per server, with a minimum-similarity floor and a cap of 20 results. That is a bi-encoder: query and tool are embedded separately and never read together.

## Is a smarter ranker worth it

Mostly not yet, for three reasons.

- **The caller masks the retriever.** When the searcher is a capable agent that can reformulate and re-query, a mediocre ranking still gets to the right tool in a turn or two. Ranking quality matters when the caller is weak or gets one shot, when the catalog runs to thousands of tools, or when many tools are near-duplicates.
- **Only the third condition applies to a fleet-sized catalog.** Several hundred tools is small. The real pressure is look-alike tools across servers (three weather sources, four literature sources, many `*_search_*` tools), which is a precision-at-the-top problem, not a recall problem.
- **Nobody has measured the current search.** There is no labeled set of queries with expected tools, so there is no evidence it fails. Every option below is unjudgeable until that exists.

## Order of work

1. **Build a labeled query set and measure the baseline.** 150 to 300 queries, each with the tool or tools that should surface, written from the user's side and not from the descriptions. Include the hard cases on purpose: look-alike tools across servers, constraints and negations ("not US-only"), multi-intent queries, and queries that need knowledge of what a data source contains. Record recall@1/3/5/10 and MRR for the current embedding search. This step is worth doing regardless of what follows.
2. **If the baseline shows a gap, close it locally first.** Each of these runs offline or in-process, with no external dependency:
   - *Enrich the embedded document*: add the server name, the server description, and a handful of generated "queries this tool answers" per tool at index build time. For bi-encoders this is usually the largest single gain, at zero runtime cost.
   - *Hybrid lexical plus embedding*: fuse a BM25 ranking over names and descriptions with the cosine ranking. Fixes exact-name and rare-keyword misses that embeddings blur.
   - *A local cross-encoder reranker* over the top candidates, in the same runtime that already hosts the embedder. It reads query and tool together, which is the property Jev would bring, without a network call.
3. **Run a Jev rerank on the same set as a ceiling check.** One experiment file in this harness: embeddings pick the top 50 to 250, Jev reorders them, `derive` computes the rank of the expected tool. The result says how much headroom ranking has at all. If Jev barely beats the enriched hybrid, stop; if it beats it clearly, that is the target a local reranker has to approach.
4. **Use Jev offline while building the set**: grading candidate labels, proposing hard negatives (tools that look right and are wrong), and flagging queries where two tools are near-tied, which doubles as a description-collision report (see [`literal-client-probe.md`](literal-client-probe.md)).

## What Jev would add in the serving path

Jev reads the query and every candidate in one pass and returns a probability per option, which is what a cross-encoder does, with three differences:

- **Structured options.** Each option can carry what the tool is for, what it is *not* for, its server, required inputs, and whether it needs an ID from another tool. Embeddings flatten all of that into one vector.
- **Conversation as state.** The state can hold the latest user message, recent turns, and tools already called, so "now get the full text" resolves against the search the user just ran.
- **A distribution, not a list.** Return three tools when the mass is concentrated, ten when it is flat, and "nothing fits" when the `none` option wins, instead of a hand-tuned similarity floor.

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

### Serving-path designs, for reference

| Design | How | Trade-off |
|:---|:---|:---|
| **A. Rerank** | Embeddings pick the top 50 to 250; Jev reorders them and sets the cut | Smallest change, keeps the offline index, safe fallback to cosine order. Cannot recover a tool the first stage dropped |
| **B. Two-stage** | Choice over servers, then Choice over the winning servers' tools | No embedding dependency. A wrong first stage is unrecoverable, so carry the top few servers forward |
| **C. Sharded single request** | Several Choice questions in one request, each over a shard of at most 254 tools plus `none` | One round trip over the whole catalog. Probabilities are normalized per shard, so cross-shard ordering may not be comparable |
| **D. Noul per tool** | One "this tool is relevant" question per candidate | Directly comparable scores and natural multi-label output. Only viable if the per-request question limit allows hundreds |

Design A is the form step 3 measures. B through D only matter if a serving-path ranker is ever built.

## When a serving-path Jev ranker becomes reasonable

- A gateway that fronts many third-party MCP servers, with thousands of tools and descriptions nobody curated.
- Callers that are small models or get one shot (voice, embedded assistants), where a wrong first result is the final result.
- A client that passes conversation context into the search, so the context-aware ranking has something to use.
- The local options in step 2 have been tried and leave a measured gap.

## Risks and open questions

- **An external paid model in a hot path.** Every search would send the user's query, and in the conversation-aware form recent turns, to OpenRouter and TypeSafe, over an endpoint still labeled alpha. That is a latency, availability, cost, and privacy change for a hosted public endpoint. Any serving-path use must be optional with a silent fallback, and disclosed.
- **Option-count and option-length limits.** 255 options is the documented ceiling; how accuracy degrades as options and description length grow is unknown.
- **Per-request question limit**, which decides whether design D is possible.
- **Whether the static option block is cached upstream.** If not, every query pays for the full catalog text again.
- **Calibration.** The adaptive cut only works if the probabilities mean something; an issue-labeling run over several hundred GitHub issues suggested type Choices are well behaved and some Noul flags are overconfident. Check calibration on the labeled set before relying on the distribution.
- **Model pinning.** A ranker tuned on one Jev version needs re-evaluation on the next; the labeled set is the regression suite.

## Decisions

- **The labeled set comes first.** It is the only step that is worth doing unconditionally, and nothing else can be judged without it.
- **Local before external.** Index enrichment, hybrid ranking, and a local cross-encoder are tried before any paid model sits in the search path; they carry no dependency, no per-query cost, and no query leaves the process.
- **Jev's role is measurement.** It runs offline as a ceiling check and labeling aid. A serving-path ranker is revisited only under the conditions listed above.
