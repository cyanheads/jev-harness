# Writing questions for Jev

Condensed from TypeSafe's docs. The live pages are the source of truth: [primitives](https://docs.typesafe.ai/primitives.md), [confidence](https://docs.typesafe.ai/confidence.md), [state](https://docs.typesafe.ai/concepts/state.md), [advanced structure](https://docs.typesafe.ai/primitives/advanced.md), and the per-version failure-mode page ([jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)). Re-read the jaggedness page when a new Jev version ships.

## The model

Jev does not generate text. It ingests `state` once and answers every question in one parallel pass, returning only values inside the schema you declared, each with probabilities. It cannot return an invalid value; it can return the wrong valid one. Jev is trained with RLCD so that confidence tracks accuracy in aggregate. Text only, English best, 32k tokens for state plus the longest question, 64k for state plus all questions.

## Rules

1. **One snap judgment per question.** Something a knowledgeable person answers in a second. Split anything that needs reasoning into several questions and combine them in code.
2. **Ask everything in one call.** Extra questions cost tokens, not time. Ask the branch-specific questions up front and let code ignore the ones that don't apply.
3. **Write the literal condition.** Jev answers the question as written. Negations, scoping words, implied conditions are taken at face value. If you find yourself explaining what you meant after a wrong answer, that explanation belongs in `instructions`.
4. **The question ID is not sent.** Put the whole question in `instructions`.
5. **Choice sets get an `other`/`unclear` option** so the model can say nothing fits.
6. **Score levels describe concrete situations**, in order, standing on their own. Use Score for "how much", Noul for "whether". A Noul at 0.5 means "equally likely yes or no", not "medium".
7. **Criteria extend the instruction; never contradict it.** A Noul where `true` means "no" underperforms. Noul criteria are both sides or neither — OpenRouter rejects `{ false }` alone with a 400.
8. **Point at state by path** in backticks: `` `ticket.messages[0].text` ``. Name fields in the state object; send only the fields the questions need. Irrelevant material lowers accuracy.
9. **Structured entries when boundaries are close.** An option can be `{ what, not_for, examples }`. For a deep taxonomy, one Choice per level, walked in code. (The harness JSON-encodes structured entries for OpenRouter, which accepts strings only.)
10. **Keep in code:** counting, arithmetic, date comparison (have Jev pick month/day from enumerated options with a "not stated" choice, assemble in code), numeric encodings (convert hex colors to names first), and any generation (find candidates with a regex or an LLM, let Jev pick).

## Reading answers

- `confidence` summarizes how peaked the distribution is. A flat distribution usually means the criteria don't separate the options for that state, not that the model is confused.
- Thresholds scale with risk: one floor for "route to a human" (their examples use ~0.5), then a per-action bar. Tune on your own data, then **pin the model version** (`JEV_MODEL=typesafe/jev-1.13`); aliases move.
- Don't expect arithmetic identities across questions. `P(noul)` and `1 - P(not noul)` won't sum to 1; a threshold tuned on a Noul doesn't carry to a Choice. A Choice is relative (which option), a Noul is absolute (does this hold).
- State is not treated as hostile. Text that argues for its own classification can move the answer; if users control the state, test that.
