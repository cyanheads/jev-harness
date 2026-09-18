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
import { choice, noul, score } from '../src/questions/index.ts';

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

const ESCALATE_MIN_SEVERITY = 2;
const ESCALATE_MIN_CONFIDENCE = 0.6;

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
    dx_gap: noul(
      'A better tool description or input schema (examples, format constraints, how to obtain IDs) would likely have prevented this call.',
      {
        true: 'The mistake is one the tool could have steered the caller away from.',
        false: 'The call was fine; the failure came from elsewhere.',
      },
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
    return {
      heuristic,
      agrees_with_heuristic: answers.origin.choice === heuristic,
      escalate:
        answers.severity.score >= ESCALATE_MIN_SEVERITY &&
        answers.severity.confidence >= ESCALATE_MIN_CONFIDENCE,
    };
  },
});
