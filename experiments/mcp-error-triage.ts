/**
 * experiments/mcp-error-triage.ts
 *
 * Second reader for errors from hosted MCP servers. Input records carry the
 * shape RemoteSysAdmin's `collect-mcp-errors.ts --json` emits (`container`,
 * `scope`, `message`, `toolMessage`, `recoveryHint`, `errorCode`, `statusCode`,
 * `count`, `kind`, and the script's rule-based `errorClass`), or the same shape
 * collapsed across tools by `triage-mcp-errors.ts`, which adds `tools`.
 *
 * Two questions, the two that held up on real data (docs/findings.md): whether
 * Jev's origin call agrees with the rule-based one, and whether what the caller
 * was shown — the tool's message and the recovery hint the framework appends to
 * it — says what went wrong. `errorClass` stays out of the state so
 * Jev judges the error, not the label. How often an error happened is not asked
 * about and not sent: a count sorts itself, and a severity question that saw it
 * only restated it.
 *
 * Sample input: samples/mcp-errors.jsonl
 */

import { defineExperiment } from '../src/experiments/index.ts';
import { choice, score } from '../src/questions/index.ts';

interface McpError {
  readonly container: string;
  readonly kind: 'tool' | 'transport';
  readonly scope: string;
  /** Every tool the pattern appeared on, when the input was collapsed across tools. */
  readonly tools?: readonly string[];
  /** The most specific detail the logs hold — often the upstream response body. */
  readonly message: string;
  /** What the caller was shown, when that differs from `message`. */
  readonly toolMessage?: string;
  /** The recovery hint the framework appended to what the caller was shown. */
  readonly recoveryHint?: string;
  readonly errorClass: 'INPUT' | 'UPSTREAM' | 'CAPACITY' | 'SERVER';
  readonly errorCode: string;
  readonly statusCode?: number;
  readonly count?: number;
}

/** Below this, a disagreement with the rules was usually Jev's mistake, not theirs. */
const DISAGREE_MIN_CONFIDENCE = 0.6;
/**
 * Jev calling `server` against the rules has been a caller's SQL error read as a
 * database fault every time it was checked (0.60–0.74); its `upstream` and `input`
 * disagreements are where the real finds were, so only this one is held higher.
 */
const SERVER_CALL_MIN_CONFIDENCE = 0.75;
/** A weighted clarity score below this lands on "Opaque". */
const OPAQUE_BELOW = 0.5;
/** Long SQL and HTML bodies carry their signal in the first few hundred characters. */
const MAX_TEXT = 600;
const MAX_TOOLS = 5;

export default defineExperiment({
  name: 'mcp-error-triage',
  description:
    'Second reader for hosted MCP server errors: origin against the rules, and clarity of the text shown to the caller.',
  questions: {
    origin: choice(
      {
        question: 'Who is responsible for this error?',
        focus: 'Judge from the `error` fields only.',
      },
      {
        input: {
          what: 'The calling model sent a bad request: invalid or missing parameter, malformed ID, wrong format, unknown tool, or a lookup that matched nothing.',
          examples: ['validation failed', 'Invalid params', 'required field', 'not found for id'],
        },
        upstream: {
          what: 'The third-party API behind the server failed or rejected the request: timeout, 5xx, rate limit, upstream 4xx.',
          examples: ['upstream returned 503', 'rate limit exceeded', 'fetch timed out'],
        },
        capacity: {
          what: 'A per-tenant limit inside the server itself was hit, such as a dataframe or storage cap.',
        },
        server: {
          what: 'A bug in the server: unhandled exception, type error, null access, assertion, internal error with no upstream cause.',
        },
        unclear: 'The error does not contain enough to tell.',
      },
    ),
    message_clarity: score(
      {
        question:
          'How well do `error.shown_to_caller` and `error.recovery_shown_to_caller` together tell the caller what went wrong and how to fix the call?',
        focus:
          'The caller saw `error.shown_to_caller` followed by `error.recovery_shown_to_caller` when it is present. `error.upstream_detail` was never shown.',
      },
      [
        'Opaque: a generic or internal message, a bare status code, or markup, with no usable detail.',
        'Names the cause: says which field or condition failed.',
        'Names the cause and the remedy: says what a valid call looks like or what to do next.',
      ],
    ),
  },
  state: (record: McpError) => ({
    server: record.container,
    tool: (record.tools ?? [record.scope]).slice(0, MAX_TOOLS).join(', '),
    error: {
      kind: record.kind,
      errorCode: record.errorCode,
      ...(record.statusCode !== undefined && { statusCode: String(record.statusCode) }),
      shown_to_caller: (record.toolMessage ?? record.message).slice(0, MAX_TEXT),
      ...(record.recoveryHint !== undefined && {
        recovery_shown_to_caller: record.recoveryHint.slice(0, MAX_TEXT),
      }),
      ...(record.toolMessage !== undefined && {
        upstream_detail: record.message.slice(0, MAX_TEXT),
      }),
    },
  }),
  derive: (answers, record) => {
    const heuristic = record.errorClass.toLowerCase();
    const { choice: origin, confidence } = answers.origin;
    return {
      heuristic,
      /** A disagreement is a review queue: either side can be the one that is wrong. */
      origin_disagrees:
        origin !== heuristic &&
        origin !== 'unclear' &&
        confidence >= (origin === 'server' ? SERVER_CALL_MIN_CONFIDENCE : DISAGREE_MIN_CONFIDENCE),
      opaque_message: answers.message_clarity.score < OPAQUE_BELOW,
    };
  },
});
