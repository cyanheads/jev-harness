/**
 * experiments/ticket-routing.ts
 *
 * The canonical support-ticket example: route to a team, gauge frustration,
 * and ask the speculative refund question up front. Smallest possible
 * experiment — copy this file to start a new one.
 *
 * Sample input: samples/tickets.jsonl
 */

import { defineExperiment } from '../src/experiments/index.ts';
import { choice, noul, score } from '../src/questions/index.ts';

interface Ticket {
  readonly subject: string;
  readonly body: string;
}

export default defineExperiment({
  name: 'ticket-routing',
  description: 'Route a support ticket to a team and flag refund requests.',
  questions: {
    team: choice('Which team should handle this ticket?', {
      billing: 'Payments, invoices, refunds, subscriptions',
      technical: 'Bugs, errors, integrations, outages',
      sales: 'Pricing, plans, upgrades, new accounts',
      other: 'Anything the three teams above do not cover',
    }),
    frustration: score('How frustrated does the customer appear?', [
      'Calm, just stating facts',
      'Frustrated but civil',
      'Very angry, strong language',
    ]),
    refund_requested: noul('The customer explicitly asks for a refund or credit.'),
  },
  state: (record: Ticket) => ({ subject: record.subject, body: record.body }),
  derive: (answers) => ({
    route: answers.team.confidence < 0.5 ? 'human' : answers.team.choice,
    refund_flow: answers.refund_requested.noul > 0.7 && answers.team.choice === 'billing',
  }),
});
