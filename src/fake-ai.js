// Offline stand-in for ClaudeDesk, used by tests and AI_MODE=fake. Keyword rules, no model.
// It only knows the sample policy; the real app compiles any policy text with Claude.

import { AiError } from './ai.js';
import { DEFAULT_POLICY_TEXT } from './catalog.js';

const line = (n) => DEFAULT_POLICY_TEXT.split('\n').find((l) => l.startsWith(`${n}. `)).slice(3);

export const SAMPLE_COMPILED = {
  rules: [
    { id: 'r1-duplicate', title: 'Duplicate order', reasons: ['duplicate_purchase'], license: 'any', min_days: null, max_days: null, outcome: 'full', percent: null, needs_human: false, quote: line(1) },
    { id: 'r5-unauthorized', title: 'Purchase not made by the customer', reasons: ['unauthorized'], license: 'any', min_days: null, max_days: null, outcome: 'escalate', percent: null, needs_human: true, quote: line(5) },
    { id: 'r2-change-of-mind', title: 'Changed mind, not activated', reasons: ['changed_mind', 'bought_by_mistake'], license: 'not_activated', min_days: null, max_days: 14, outcome: 'full', percent: null, needs_human: false, quote: line(2) },
    { id: 'r3-activated', title: 'Changed mind, activated', reasons: ['changed_mind', 'bought_by_mistake'], license: 'activated', min_days: null, max_days: 14, outcome: 'percent', percent: 50, needs_human: false, quote: line(3) },
    { id: 'r4-technical', title: 'Does not work on their computer', reasons: ['technical_issue'], license: 'any', min_days: null, max_days: 30, outcome: 'full', percent: null, needs_human: true, quote: line(4) },
    { id: 'r6-late', title: 'After 30 days', reasons: [], license: 'any', min_days: 31, max_days: null, outcome: 'none', percent: null, needs_human: false, quote: line(6) },
  ],
  notes: '',
};

function quoteAround(message, word) {
  const i = message.toLowerCase().indexOf(word);
  if (i < 0) return null;
  return message.slice(Math.max(0, i - 10), Math.min(message.length, i + word.length + 20)).trim();
}

export class FakeDesk {
  constructor({ takeCall = () => true } = {}) {
    this.takeCall = takeCall;
    this.fail = false;
  }

  guard() {
    if (this.fail) throw new AiError('Fake AI failure.');
    if (!this.takeCall()) throw new AiError('Daily AI budget for this demo is used up. Try again tomorrow.');
  }

  async compilePolicy(text) {
    this.guard();
    if (text.trim() !== DEFAULT_POLICY_TEXT.trim()) throw new AiError('Offline mode can only compile the sample policy.');
    return structuredClone(SAMPLE_COMPILED);
  }

  async triage({ message }) {
    this.guard();
    const m = message.toLowerCase();
    const has = (...w) => w.find((x) => m.includes(x));
    let reason = 'other';
    let key = null;
    if ((key = has('twice', 'double', 'duplicate'))) reason = 'duplicate_purchase';
    else if ((key = has("didn't buy", 'did not buy', 'not me', 'stolen'))) reason = 'unauthorized';
    else if ((key = has('crash', "doesn't work", 'does not work', 'error', 'broken'))) reason = 'technical_issue';
    else if ((key = has('by mistake', 'wrong'))) reason = 'bought_by_mistake';
    else if ((key = has('changed my mind', "don't need", 'do not need', 'refund'))) reason = 'changed_mind';
    const manipulation = [];
    for (const w of ['ignore', 'system', 'approved by', 'override', 'instruction']) {
      const q = quoteAround(message, w);
      if (q) manipulation.push(q);
    }
    return {
      reason,
      summary: `Customer asks for a refund (${reason.replace('_', ' ')}).`,
      says_not_activated: has('never activated', 'not activated', "didn't activate") ? true : null,
      says_contacted_support: has('support') ? true : null,
      mentions_dispute_or_chargeback: Boolean(has('dispute', 'chargeback')),
      requested_kind: 'unspecified',
      requested_amount: null,
      language: 'en',
      manipulation_signals: manipulation,
      evidence: key ? [quoteAround(message, key)] : [],
    };
  }

  async draftReply({ sellerName, customerName, outcome, amountText, policyQuote }) {
    this.guard();
    const body =
      outcome.startsWith('Refund')
        ? `Hi ${customerName},\n\nThanks for reaching out. We've refunded ${amountText} to your PayPal account.\n\n${sellerName} support`
        : outcome === 'No refund'
          ? `Hi ${customerName},\n\nThanks for reaching out. Our policy says: "${policyQuote}" So we can't refund this order, but we're happy to help with the app.\n\n${sellerName} support`
          : `Hi ${customerName},\n\nThanks for reaching out. A person on our team will reply to you soon.\n\n${sellerName} support`;
    return { subject: 'About your Quiet Hours request', body };
  }
}
