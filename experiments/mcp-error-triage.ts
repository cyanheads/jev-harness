/**
 * experiments/mcp-error-triage.ts
 *
 * Triage errors from hosted MCP servers. Input records carry the shape the
 * RemoteSysAdmin `collect-mcp-errors.ts` digest groups by (`scope`, `message`,
 * `errorCode`, `statusCode`, `count`, `kind`) plus `container` and the
 * script's heuristic `errorClass` (INPUT / UPSTREAM / CAPACITY / SERVER).
 *
 * Two things this measures: whether Jev's origin call agrees with the
 * heuristic classifier, and — the DX angle — whether the error message itself
 * tells the calling model what to do next. `errorClass` is deliberately kept
 * out of the state so Jev judges the error, not the label.
 *
 * Sample input: samples/mcp-errors.jsonl
 */

import { defineExperiment } from '../src/experiments/index.ts';
import { choice, score } from '../src/questions/index.ts';

interface McpError {
  readonly container: string;
  readonly kind: 'tool' | 'transport';
  readonly scope: string;
  readonly message: string;
  readonly errorClass: 'INPUT' | 'UPSTREAM' | 'CAPACITY' | 'SERVER';
  readonly errorCode: string;
  readonly statusCode?: number;
  readonly count?: number;
}

/**
 * Escalate when the probability mass on "Needs a fix" and "Outage-class" together
 * reaches this. The top level's own confidence is a poor gate on a four-level
 * Score: it averaged 0.55 on a real week of errors, so a 0.6 bar passed 1% of rows.
 */
const ESCALATE_MIN_MASS = 0.8;
/** A weighted clarity score below this lands on "Opaque". */
const OPAQUE_BELOW = 0.5;

export default defineExperiment({
  name: 'mcp-error-triage',
  description: 'Classify hosted MCP server errors by origin, severity, and error-message clarity.',
  questions: {
    origin: choice(
      {
        question: 'Who is responsible for this error?',
        focus: 'Judge from `error.message`, `error.errorCode`, and `error.statusCode` only.',
      },
      {
        input: {
          what: 'The calling model sent a bad request: invalid or missing parameter, malformed ID, wrong format, unknown tool.',
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
        unclear: 'The message does not contain enough to tell.',
      },
    ),
    severity: score('How serious is this error for the operator of the server?', [
      'Noise: expected rejection of bad input or a transient upstream blip; nothing to do.',
      'Worth a look: recurring or unusual, but the service keeps working.',
      'Needs a fix: a real bug or a systematic misuse the tool description could prevent.',
      'Outage-class: the tool or the whole server is unusable.',
    ]),
    message_clarity: score(
      'How well does `error.message` tell the caller what went wrong and how to fix the call?',
      [
        'Opaque: a generic or internal message with no usable detail.',
        'Names the cause: says which field or condition failed.',
        'Names the cause and the remedy: says what a valid call looks like.',
      ],
    ),
  },
  state: (record: McpError) => ({
    server: record.container,
    tool: record.scope,
    error: {
      kind: record.kind,
      errorCode: record.errorCode,
      ...(record.statusCode !== undefined && { statusCode: String(record.statusCode) }),
      message: record.message,
      occurrences: String(record.count ?? 1),
    },
  }),
  derive: (answers, record) => {
    const heuristic = record.errorClass.toLowerCase();
    const levels = answers.severity.probabilities;
    return {
      heuristic,
      /** A disagreement is a review queue: either side can be the one that is wrong. */
      agrees_with_heuristic: answers.origin.choice === heuristic,
      escalate: (levels['2'] ?? 0) + (levels['3'] ?? 0) >= ESCALATE_MIN_MASS,
      opaque_message: answers.message_clarity.score < OPAQUE_BELOW,
    };
  },
});
