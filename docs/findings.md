# Findings

What measurement has shown about Jev's behavior, as opposed to what its docs say. Each section names the model version, the data, the method, and what to do differently because of it. Update a section in place when a new run supersedes it; add a section for a new question.

All runs below: `typesafe/jev-1.13-20260917` through OpenRouter.

## Run-to-run stability

**Data:** 120 GitHub issues, each sent three times with identical state and questions (one Choice, seven Nouls, two four-level Scores). `jev stability <rows>...`.

| Answer type | Mean largest difference | Worst case | Records moving more than 0.05 |
|:---|---:|---:|---:|
| Choice (per-option probability) | 0.005 | 0.06 | 2 of 120 |
| Noul | 0.003 to 0.008 | 0.07 | 0 to 2 of 120 |
| Score (weighted, 0 to 3 scale) | 0.027 | 0.13 | 17 to 20 of 120 |

No Choice changed its selected option across the three runs.

**What it means.** Answers are not bit-identical, but the noise is about one hundredth of a probability point. A threshold does not need hysteresis, a single run is enough, and a before/after comparison can treat a Choice or Noul difference above roughly 0.1 as real. Scores are noisier in absolute terms because the weighted value spans a wider range; compare level probabilities, not the weighted score, when a small difference matters.

## Calibration: a Choice with well-separated options

**Data:** 712 issues with a maintainer-assigned type label, five-option Choice (`bug`, `enhancement`, `documentation`, `question`, `other`). Truth is the label on the issue after a hand review of every row where Jev disagreed. `jev calibrate --rows … --truth …`.

| Confidence | Rows | Correct |
|:---|---:|---:|
| 0.9 to 1.0 | 597 | 99.8% |
| 0.8 to 0.9 | 28 | 96% |
| 0.7 to 0.8 | 33 | 94% |
| 0.6 to 0.7 | 23 | 96% |
| 0.4 to 0.6 | 26 | 73% |
| below 0.4 | 5 | 40% |

Top-1 accuracy 97.9%, expected calibration error 0.039.

**What it means.** On this kind of question Jev is *under*confident in the middle: a stated 0.65 was right 96% of the time. Confidence at or above 0.6 can be acted on; the region below 0.6 is where review effort belongs, and it was 4% of rows. One caveat on the method: rows where Jev agreed with the existing label were not independently reviewed, so the top bin's accuracy assumes the existing labels are right.

## Calibration: Noul flags against a labeling policy

**Data:** the same 713 issues, five Noul flags (security, performance, regression, breaking change, blocked upstream). Truth is whether the label is on the issue after review.

| Stated probability | What happened |
|:---|:---|
| below 0.2 | The label was present on 1 of roughly 3,100 question-rows. A low Noul is a reliable "no" |
| 0.3 to 0.7 | Observed rate 0 to 25% against a stated 35 to 65%. These rows were not individually reviewed, so the observed rate is a floor, but the gap is too large to be only that |
| 0.7 to 0.9 | Reviewed by hand. Between none and two thirds held, depending on the flag (bins with more than one row) |
| 0.9 to 1.0 | 100% for security and breaking change, 63% for performance, 40% for blocked upstream, 33% for regression |

**What it means.** The ordering is sound and the magnitudes are not: a Noul works as a screen and as a ranking, not as a trigger. Two separate causes sit behind the overconfidence, and only one is Jev's:

- **The question and the policy differed.** The performance Noul mentioned rate limits; the maintainers' label definition does not count rate-limit messaging. The blocked-upstream Noul asked whether the text *says* the work is blocked; whether the blocker is still open is not in the text. Jev answered the question it was given. A flag is only as good as the match between its wording and the decision it feeds, and that match has to be checked against reviewed examples, not assumed.
- **Literal reading over-fires on surface cues.** "Now returns 403" reads as a regression; an upstream API changing under a server is not one by the label's definition. Two-sided criteria that name the look-alike case ("an upstream change is not a regression") are the available fix, and re-measuring after the rewrite is the only way to know it worked.

Practical rule until a flag has been measured: treat below 0.2 as no, send at or above 0.7 to review, and never auto-apply.

## Error triage on a real week of server errors

**Data:** 1,082 grouped errors from hosted MCP servers over seven days, `experiments/mcp-error-triage.ts`. Input cost: four cents. A rule-based classifier's origin label was held out of the state and compared in `derive`.

- **Origin agreed with the rules on 93.9% of rows.** The 66 disagreements were the useful output. About a fifth were Jev being right: client disconnects and aborted upstream fetches that the rules tallied as server bugs were called upstream or unclear, at 0.84 to 0.94 confidence where Jev committed. A third were Jev being wrong at low confidence (0.36 to 0.49), calling a caller's malformed SQL a server bug. The rest were ambiguous by construction: a bare "fetch failed with status 404" does not say whose fault it is.
- **`message_clarity` was precise about the text it was given, and the text was the wrong one.** Its "Opaque" level picked out 27 groups that read as real: HTML error pages, bare status codes. The input's `message` field, though, held the most specific detail in the logs, which is often the upstream response body. Checked against raw logs, the caller of the HTML group had been shown `Fetch failed … Status: 403`, and the caller of a "bare 429" group had been shown a full rate-limit message with a retry time. The input now carries the caller-facing text separately and the question reads only that. On the same week, 21 of 660 patterns scored opaque.
- **The caller-facing text was still half of what the caller saw.** The framework renders a tool error as the message followed by a `Recovery:` hint, and the hint was not in the state. On a three-day window 18 patterns scored opaque; verified one by one, 14 of them had shown the caller a hint naming the remedy ("Use who_search_indicators to find valid indicator codes…"). With the hint sent as `recovery_shown_to_caller` and the question reading both fields, the same window scored 4 opaque, and all 4 carried no hint. 603 of 956 groups had one.
- **On a verified three-day review, origin disagreements were the productive signal.** Of eight issues that survived raw logs, source, and reproduction, five came from an `upstream` or `input` call against the rules at 0.72 to 0.99. Every `server` call against an `input` label (seven, at 0.60 to 0.74) was a caller's SQL binder error, so that one direction now needs 0.75.
- **The `severity` Score restated the occurrence count.** Gated on the top two levels' summed probability it escalated 157 rows; 143 of them were flagged by nothing else, 128 of those were input errors with clear messages, and the list tracked the `occurrences` field in the state. A sort by count gives the same ranking for free, so the question and the field are both gone.
- **The `dx_gap` Noul was removed.** "A better description would have prevented this call" came back above 0.7 for 58% of input errors. A question that is true of most rows separates nothing.
- **No question flagged the largest patterns.** One upstream's rate limit accounted for 214 occurrences across four tools and no signal picked it up. Volume needs its own lane in whatever consumes the rows; Jev is not a substitute for a count.
- **Collapsing near-duplicates first halved the input.** 1,083 groups became 675 patterns once caller-supplied values (quoted strings, numbers, URLs) were normalized and the same message on several tools was folded. Tokens went from 992k to about 500k, the run from about 30 seconds to 10 at a concurrency of 16, the cost to two cents.

**What it means.** Jev does not replace the rule-based classifier; the rules are free and agree with it 94% of the time. It earns its place as a second reader: the disagreement list is a short review queue that catches misclassification in either direction, and the clarity score finds error messages worth rewriting, which no rule does. It ranks leads for someone who will verify them. Several leads from the first run did not survive a look at the raw logs, all for the wrong-text reason above: the callers had been shown clear, actionable messages.

## Working rules drawn from the above

- Trust a well-separated Choice at 0.6 and up; spend review on what falls below.
- Use a Noul to rule out and to rank. Measure it against reviewed examples before giving it a threshold that triggers anything.
- On a Score, gate on summed level probabilities, not on the top level's confidence.
- When a held-out label exists, the disagreements are the deliverable.
- A question that is true of most records is noise; check each question's base rate on real data before keeping it.
- Check that each field in the state is what its name says before trusting a question about it. A precise answer about the wrong text looks identical to a precise answer about the right one.
- If an answer tracks a number that was sent in the state, drop the question and sort by the number.
- Deduplicate before sending. Normalizing the values that vary between otherwise identical records is the cheapest cost reduction available.
