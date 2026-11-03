// Regression tests for the findings of the adversarial review (2026-11-04).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { decide, replyAmountsAreSafe } from '../src/policy.js';
import { SAMPLE_COMPILED } from '../src/fake-ai.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const triage = {
  reason: 'changed_mind', summary: 's', says_not_activated: null, says_contacted_support: null,
  mentions_dispute_or_chargeback: false, requested_kind: 'unspecified', requested_amount: null,
  language: 'en', manipulation_signals: [], evidence: ['changed my mind'],
};
const facts = (over = {}) => ({
  orderId: 'O1', captureId: 'C1', captureStatus: 'COMPLETED', capturedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
  currency: 'USD', capturedCents: 2900, refundedCents: 0, remainingCents: 2900, ...over,
});
const base = (over = {}) => ({
  policy: SAMPLE_COMPILED, facts: facts(over.facts), dispute: { state: 'none' }, triage,
  message: 'Hi, I changed my mind about this app.', sale: { activated: false, ...over.sale },
  duplicate: { found: false, orderIds: [] }, previousRequests: over.previousRequests || 0,
  autoRefundLimitCents: 3000, now: NOW,
});

test('L1: reply guard catches amounts after the number, other languages, percents, spelled-out money', () => {
  const ok = { allowedCents: [1450] };
  for (const bad of ['500 US$', '500 $', '500 dólares', '500ドル', 'refunded in full (100%)', 'fifty dollars back', 'USD 29.00']) {
    assert.equal(replyAmountsAreSafe(`We sent ${bad}.`, ok), false, bad);
  }
  assert.equal(replyAmountsAreSafe('We refunded $14.50 to your PayPal account.', ok), true);
  assert.equal(replyAmountsAreSafe('14.50달러를 환불했습니다. 원하시면 연락 주세요. 프로그램 문의도 환영합니다.', ok), true);
});

test('H1 (engine): percent rule counts earlier refunds on the same order', () => {
  const d = decide(base({ sale: { activated: true, activatedAt: NOW.toISOString() }, facts: { refundedCents: 1450, remainingCents: 1450, captureStatus: 'PARTIALLY_REFUNDED' } }));
  assert.equal(d.action, 'deny');
  assert.equal(d.amountCents, 0);
});

test('H1 (engine): a repeat request for the same order never refunds without a click', () => {
  const d = decide(base({ previousRequests: 1 }));
  assert.equal(d.amountCents, 2900);
  assert.equal(d.route, 'approval');
});

let t;
test.beforeEach(async () => {
  t = await startTestServer();
});
test.afterEach(async () => {
  await t.close();
});
const paypalOrder = (id) => t.fake.orders.get(id);

test('H1: asking again after a 50% refund does not pay the rest', async () => {
  await t.approvePolicy();
  const sale = await t.buy();
  await t.api('POST', `/api/licenses/${sale.licenseKey}/activate`);
  const first = await t.openAndWait(sale.orderId, 'Changed my mind, I do not need it anymore.');
  assert.equal(first.case.status, 'refunded');
  const second = await t.openAndWait(sale.orderId, 'Changed my mind, I do not need it anymore.');
  assert.notEqual(second.case.status, 'refunded');
  assert.equal(paypalOrder(sale.orderId).purchase_units[0].payments.refunds.length, 1);
});

test('H2: "paid twice" cannot refund both copies', async () => {
  await t.approvePolicy();
  const a = await t.buy();
  const b = await t.buy();
  const rb = await t.openAndWait(b.orderId, 'Oops, I paid twice for the same license. Please refund one.');
  assert.equal(rb.case.status, 'refunded');
  const ra = await t.openAndWait(a.orderId, 'Oops, I paid twice for the same license. Please refund one.');
  assert.notEqual(ra.case.status, 'refunded');
  assert.equal(paypalOrder(a.orderId).purchase_units[0].payments.refunds.length, 0);
});

test('M1: a fully refunded license cannot be activated', async () => {
  await t.approvePolicy();
  const sale = await t.buy();
  const r = await t.openAndWait(sale.orderId, 'I changed my mind, refund please.');
  assert.equal(r.case.status, 'refunded');
  const act = await t.api('POST', `/api/licenses/${sale.licenseKey}/activate`);
  assert.equal(act.status, 409);
  assert.equal(act.body.error.code, 'license_revoked');
});

test('M2: declining a proposed refund never tells the customer it was refunded', async () => {
  await t.approvePolicy();
  const sale = await t.buy('quiet-hours-team');
  const r = await t.openAndWait(sale.orderId, 'I changed my mind, refund please.');
  assert.equal(r.case.decision.action, 'refund');
  const res = await t.api('POST', `/api/desk/cases/${r.body.id}/decline`, { replyBody: r.case.reply.body });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body.sentReply.body, /refunded|\$/i);
});

test('M2: a seller-edited decline that still names an amount is refused', async () => {
  await t.approvePolicy();
  const sale = await t.buy('quiet-hours-team');
  const r = await t.openAndWait(sale.orderId, 'I changed my mind, refund please.');
  const res = await t.api('POST', `/api/desk/cases/${r.body.id}/decline`, { replyBody: 'Hi, we sent you $119.00 back.' });
  assert.equal(res.status, 422);
});

test('M3: a lost refund response leaves the case retryable, and the retry pays once', async () => {
  await t.approvePolicy();
  const sale = await t.buy('quiet-hours-team');
  const r = await t.openAndWait(sale.orderId, 'I changed my mind, refund please.');
  const real = t.desk.paypal.refundCapture.bind(t.desk.paypal);
  t.desk.paypal.refundCapture = async (...args) => {
    await real(...args); // PayPal refunded, but the answer was lost on the way back
    throw new TypeError('fetch failed');
  };
  const failed = await t.api('POST', `/api/desk/cases/${r.body.id}/approve`, {});
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'refund_unknown');
  assert.equal(t.store.getCase(r.body.id).status, 'needs_human');
  t.desk.paypal.refundCapture = real;
  const retry = await t.api('POST', `/api/desk/cases/${r.body.id}/approve`, {});
  assert.equal(retry.status, 200);
  assert.equal(paypalOrder(sale.orderId).purchase_units[0].payments.refunds.length, 1);
});

test('L2: two captures of the same order issue one license', async () => {
  const created = await t.api('POST', '/api/checkout/orders', { productId: 'quiet-hours-pro' });
  await fetch(`${t.fakeBase}/fake/approve/${created.body.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const [a, b] = await Promise.all([
    t.api('POST', `/api/checkout/orders/${created.body.id}/capture`),
    t.api('POST', `/api/checkout/orders/${created.body.id}/capture`),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.licenseKey, b.body.licenseKey);
  assert.equal(t.store.state.sales.length, 1);
});

test('L3: malformed rules and amounts are 400s, not crashes', async () => {
  await t.api('POST', '/api/desk/policy/compile', { text: t.store.policy.text });
  const rules = await t.api('POST', '/api/desk/policy/approve', { rules: [{}] });
  assert.equal(rules.status, 400);
  await t.approvePolicy();
  const sale = await t.buy('quiet-hours-team');
  const r = await t.openAndWait(sale.orderId, 'I changed my mind, refund please.');
  const amount = await t.api('POST', `/api/desk/cases/${r.body.id}/approve`, { amount: '12.345' });
  assert.equal(amount.status, 400);
});

test('L4: a resolved dispute unblocks the order, even if an update arrives after it', async () => {
  await t.approvePolicy();
  const sale = await t.buy('quiet-hours-team');
  const captureId = t.store.findSaleByOrderId(sale.orderId).captureId;
  const send = (id, type, status) =>
    t.api('POST', '/api/webhooks/paypal', { id, event_type: type, resource: { dispute_id: 'PP-D-7', status, disputed_transactions: [{ seller_transaction_id: captureId }] } }, { 'paypal-transmission-sig': 'fake-valid' });
  await send('WH-a', 'CUSTOMER.DISPUTE.CREATED', 'OPEN');
  assert.equal(t.store.findSaleByOrderId(sale.orderId).disputed, true);
  await send('WH-b', 'CUSTOMER.DISPUTE.RESOLVED', 'RESOLVED');
  await send('WH-c', 'CUSTOMER.DISPUTE.UPDATED', 'RESOLVED');
  assert.equal(t.store.findSaleByOrderId(sale.orderId).disputed, false);
});

test('sandbox quirk: when the dispute filter answers 400, open disputes are still found by scanning', async () => {
  await t.approvePolicy();
  const sale = await t.buy('quiet-hours-team');
  const captureId = t.store.findSaleByOrderId(sale.orderId).captureId;
  await fetch(`${t.fakeBase}/fake/break-dispute-filter`, { method: 'POST' });
  const clean = await t.openAndWait(sale.orderId, 'I changed my mind, refund please.');
  assert.equal(clean.case.dispute.state, 'none');
  await fetch(`${t.fakeBase}/fake/disputes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureId }) });
  const blocked = await t.api('POST', `/api/desk/cases/${clean.body.id}/approve`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'dispute_open');
});
