// Policy checks and the refund decision engine.
// The model reads text (policy and customer message). This file decides money, using only:
//   - the rules the seller approved,
//   - payment facts read from PayPal,
//   - store records (license activation, other orders).
// Nothing the customer writes can raise an amount above what these allow.

import { REASONS } from './schemas.js';
import { percentOf, formatMoney } from './money.js';

const DAY_MS = 86_400_000;

export function normalizeText(s) {
  return String(s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isVerbatim(quote, source) {
  const q = normalizeText(quote);
  return q.length >= 8 && normalizeText(source).includes(q);
}

// Returns one list of problems per rule; a policy is approvable only when every list is empty.
export function validateCompiledPolicy(compiled, policyText) {
  const ruleProblems = compiled.rules.map((r) => {
    const p = [];
    if (!isVerbatim(r.quote, policyText)) p.push('Quote is not found word-for-word in the policy text.');
    if (r.reasons.some((x) => !REASONS.includes(x))) p.push('Unknown reason code.');
    if (r.outcome === 'percent' && !(r.percent > 0 && r.percent < 100)) p.push('Percent must be between 0 and 100.');
    if (r.outcome !== 'percent' && r.percent !== null) p.push('Percent is set on a non-percent rule.');
    if (r.min_days !== null && r.min_days < 0) p.push('min_days is negative.');
    if (r.max_days !== null && r.max_days < 0) p.push('max_days is negative.');
    if (r.min_days !== null && r.max_days !== null && r.min_days > r.max_days) p.push('min_days is above max_days.');
    return p;
  });
  const ids = compiled.rules.map((r) => r.id);
  const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  const problems = [];
  if (!compiled.rules.length) problems.push('No rules were found.');
  if (duplicateIds.length) problems.push(`Duplicate rule ids: ${[...new Set(duplicateIds)].join(', ')}`);
  return {
    ok: problems.length === 0 && ruleProblems.every((p) => p.length === 0),
    problems,
    ruleProblems,
  };
}

function ruleMatches(rule, { reason, activated, days }) {
  if (rule.reasons.length && !rule.reasons.includes(reason)) return false;
  if (rule.license === 'activated' && !activated) return false;
  if (rule.license === 'not_activated' && activated) return false;
  if (rule.min_days !== null && days < rule.min_days) return false;
  if (rule.max_days !== null && days > rule.max_days) return false;
  return true;
}

function check(id, status, label, detail) {
  return { id, status, label, detail };
}

/**
 * @param {object} input
 * @param {object|null} input.policy   approved compiled policy ({ rules })
 * @param {object|null} input.facts    paymentFactsFromOrder(), or null when PayPal could not be read
 * @param {object} input.dispute       disputeStatus() result
 * @param {object|null} input.triage   model triage, or null when it failed
 * @param {string} input.message       the customer's message (for evidence checks)
 * @param {object} input.sale          store record (activated, activatedAt)
 * @param {object} input.duplicate     { found, orderIds }
 * @param {number} input.autoRefundLimitCents
 * @param {Date} [input.now]
 */
export function decide(input) {
  const { policy, facts, dispute, triage, message, sale, duplicate, autoRefundLimitCents } = input;
  const previousRequests = input.previousRequests || 0;
  const now = input.now || new Date();
  const checks = [];
  const escalate = (why) => ({ action: 'escalate', amountCents: 0, rule: null, route: 'human', why, checks });

  if (!facts) {
    checks.push(check('paypal', 'unknown', 'Payment read from PayPal', 'PayPal could not be reached, so no amount can be trusted.'));
    return escalate('Payment details could not be read from PayPal.');
  }
  checks.push(
    check('paypal', 'pass', 'Payment read from PayPal', `Capture ${facts.captureId}, status ${facts.captureStatus}.`),
  );

  if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(facts.captureStatus)) {
    checks.push(check('capture', 'fail', 'Capture can be refunded', `Capture status is ${facts.captureStatus}.`));
    return escalate(`The capture status is ${facts.captureStatus}.`);
  }

  const capCents = facts.remainingCents;
  checks.push(
    check(
      'remaining',
      capCents > 0 ? 'pass' : 'fail',
      'Refundable balance',
      `Captured ${formatMoney(facts.capturedCents, facts.currency)}, refunded before ${formatMoney(facts.refundedCents, facts.currency)}, remaining ${formatMoney(capCents, facts.currency)}.`,
    ),
  );
  if (capCents <= 0) {
    return { action: 'deny', amountCents: 0, rule: null, route: 'approval', why: 'This payment is already fully refunded.', checks };
  }

  if (dispute.state === 'open') {
    checks.push(check('dispute', 'fail', 'No open PayPal dispute', `Open dispute ${dispute.ids.join(', ')}. Resolve it in the PayPal Resolution Center instead of refunding twice.`));
    return escalate('An open PayPal dispute exists for this payment.');
  }
  checks.push(
    dispute.state === 'none'
      ? check('dispute', 'pass', 'No open PayPal dispute', 'Checked with the Disputes API.')
      : check('dispute', 'unknown', 'No open PayPal dispute', `Could not confirm (${dispute.reason}). A person must approve.`),
  );

  if (!triage) {
    checks.push(check('triage', 'unknown', 'Request understood', 'The AI reading failed.'));
    return escalate('The request could not be read.');
  }

  const verified = triage.evidence.filter((q) => isVerbatim(q, message));
  checks.push(
    check(
      'evidence',
      verified.length ? 'pass' : 'warn',
      'AI reading is grounded in the message',
      verified.length
        ? `${verified.length} of ${triage.evidence.length} quotes found word-for-word in the message.`
        : 'None of the quoted evidence appears in the message.',
    ),
  );

  if (triage.manipulation_signals.length) {
    checks.push(
      check('manipulation', 'warn', 'No attempt to steer the refund system', triage.manipulation_signals.slice(0, 3).join(' / ')),
    );
  } else {
    checks.push(check('manipulation', 'pass', 'No attempt to steer the refund system', 'None found.'));
  }

  if (triage.mentions_dispute_or_chargeback) {
    checks.push(check('threat', 'warn', 'No dispute or chargeback threatened', 'The customer mentions a dispute or chargeback.'));
  }

  if (previousRequests > 0) {
    checks.push(check('history', 'warn', 'First request for this order', `${previousRequests} earlier request(s) for this order. A person checks repeat requests.`));
  }

  if (triage.reason === 'unauthorized') {
    checks.push(check('unauthorized', 'fail', 'Customer made the purchase', 'The customer says they did not make this purchase.'));
  }

  let reason = triage.reason;
  if (reason === 'duplicate_purchase') {
    if (duplicate.found) {
      checks.push(check('duplicate', 'pass', 'Duplicate order exists', `Same payer and product: ${duplicate.orderIds.join(', ')}.`));
    } else {
      checks.push(check('duplicate', 'fail', 'Duplicate order exists', 'No other order from this payer for this product.'));
      reason = 'other';
    }
  }

  const activated = Boolean(sale.activated);
  if (triage.says_not_activated === true && activated) {
    checks.push(
      check('activation', 'warn', 'Activation matches records', `Customer says the license was not activated; records show activation at ${sale.activatedAt}.`),
    );
  } else {
    checks.push(check('activation', 'pass', 'Activation matches records', activated ? `Activated at ${sale.activatedAt}.` : 'Not activated.'));
  }

  if (!policy) {
    checks.push(check('policy', 'fail', 'Approved policy', 'No approved refund policy yet.'));
    return escalate('No approved refund policy.');
  }

  const days = Math.max(0, Math.floor((now.getTime() - new Date(facts.capturedAt).getTime()) / DAY_MS));
  const rule = policy.rules.find((r) => ruleMatches(r, { reason, activated, days })) || null;
  if (!rule) {
    checks.push(check('policy', 'warn', 'A policy rule applies', `No rule covers reason "${reason}" at day ${days}.`));
    return { ...escalate('No policy rule covers this request.'), days, reason };
  }
  checks.push(check('policy', 'pass', 'A policy rule applies', `${rule.title} (day ${days}).`));

  if (rule.outcome === 'escalate') {
    return { action: 'escalate', amountCents: 0, rule, route: 'human', why: 'The policy hands this case to a person.', checks, days, reason };
  }
  if (rule.outcome === 'none') {
    return { action: 'deny', amountCents: 0, rule, route: 'approval', why: 'The policy gives no refund here.', checks, days, reason };
  }

  // The policy amount is for the whole order, so earlier refunds on it count against it.
  const policyTotalCents = rule.outcome === 'full' ? facts.capturedCents : percentOf(facts.capturedCents, rule.percent);
  const policyCents = policyTotalCents - facts.refundedCents;
  if (policyCents <= 0) {
    checks.push(check('cap', 'fail', 'Amount within what the policy allows', `The policy allows ${formatMoney(policyTotalCents)} for this order and ${formatMoney(facts.refundedCents)} was already refunded.`));
    return { action: 'deny', amountCents: 0, rule, route: 'approval', why: 'This order already received what the policy allows.', checks, days, reason };
  }
  const amountCents = Math.min(policyCents, capCents);
  if (facts.refundedCents > 0) {
    checks.push(check('cap', 'warn', 'Amount within what the policy allows', `Policy amount ${formatMoney(policyTotalCents)} minus ${formatMoney(facts.refundedCents)} already refunded.`));
  }

  const blockers = checks.filter((c) => c.status !== 'pass');
  const autoOk = !rule.needs_human && amountCents <= autoRefundLimitCents && blockers.length === 0;
  checks.push(
    check(
      'auto',
      autoOk ? 'pass' : 'info',
      'Safe to refund without a click',
      autoOk
        ? `Within the auto-refund limit of ${formatMoney(autoRefundLimitCents)}.`
        : [
            rule.needs_human ? 'the rule asks for a person' : null,
            amountCents > autoRefundLimitCents ? `amount above the auto limit of ${formatMoney(autoRefundLimitCents)}` : null,
            blockers.length ? `${blockers.length} check(s) need a look` : null,
          ]
            .filter(Boolean)
            .join('; '),
    ),
  );
  return {
    action: 'refund',
    amountCents,
    rule,
    route: autoOk ? 'auto' : 'approval',
    why: rule.outcome === 'full' ? 'Full refund under the policy.' : `${rule.percent}% refund under the policy.`,
    checks,
    days,
    reason,
  };
}

const CURRENCY = /(US\$|\$|USD|dollars?|d[oó]lar(?:es)?|달러|ドル|美元|€|EUR|euros?|£|GBP|₩|KRW)/i;
const NUMBER = /\d{1,7}(?:[.,]\d{1,2})?/;
const MONEY = new RegExp(`(?:${CURRENCY.source})\\s?(${NUMBER.source})|(${NUMBER.source})\\s?(?:${CURRENCY.source})`, 'gi');

// Every amount written in a reply must be one the decision allows; otherwise the draft is replaced.
// Also unsafe: percentages and currency words without digits ("fifty dollars"), which cannot be checked.
export function replyAmountsAreSafe(body, { allowedCents }) {
  const text = String(body);
  if (/\d\s?%|%\s?\d|percent|퍼센트/i.test(text)) return false;
  let matched = 0;
  for (const m of text.matchAll(MONEY)) {
    matched += 1;
    const raw = (m[2] || m[3]).replace(',', '.');
    const cents = Math.round(Number(raw) * 100);
    if (!allowedCents.includes(cents)) return false;
  }
  const currencyWords = text.match(new RegExp(CURRENCY.source, 'gi')) || [];
  return currencyWords.length <= matched;
}
