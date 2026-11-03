// An in-memory stand-in for the PayPal sandbox, used by the test suite and by PAYPAL_MODE=fake
// for offline development. It follows the documented request and response shapes of the
// endpoints this app calls. It is never used when PAYPAL_MODE=sandbox.

import express from 'express';
import crypto from 'node:crypto';
import { toCents, toValue } from './money.js';

const rid = (prefix) => `${prefix}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

export function createFakePayPal() {
  const orders = new Map();
  const captures = new Map(); // captureId -> orderId
  const idempotent = new Map(); // PayPal-Request-Id -> response body
  const approvals = new Map(); // orderId -> payer
  const disputes = [];
  const router = express.Router();
  router.use(express.json());

  const error = (res, status, name, issue) =>
    res.status(status).json({ name, message: issue, debug_id: rid('dbg'), details: [{ issue }] });

  router.post('/v1/oauth2/token', (req, res) => {
    if (!req.headers.authorization?.startsWith('Basic ')) return res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: `fake-${rid('')}`, token_type: 'Bearer', expires_in: 32400 });
  });

  router.use((req, res, next) => {
    if (req.path.startsWith('/fake/')) return next();
    if (!req.headers.authorization?.startsWith('Bearer ')) return error(res, 401, 'AUTHENTICATION_FAILURE', 'NO_TOKEN');
    next();
  });

  const once = (req, res, compute) => {
    const key = req.headers['paypal-request-id'];
    if (key && idempotent.has(key)) return res.status(200).json(idempotent.get(key));
    const result = compute();
    if (!result) return;
    if (key) idempotent.set(key, result.body);
    res.status(result.status).json(result.body);
  };

  router.post('/v2/checkout/orders', (req, res) =>
    once(req, res, () => {
      const unit = req.body.purchase_units?.[0];
      if (req.body.intent !== 'CAPTURE' || !unit?.amount?.value) {
        error(res, 400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
        return null;
      }
      const order = {
        id: rid('5O'),
        intent: 'CAPTURE',
        status: 'CREATED',
        create_time: new Date().toISOString(),
        purchase_units: [{ ...unit }],
        links: [],
      };
      orders.set(order.id, order);
      return { status: 201, body: { id: order.id, status: order.status, links: [] } };
    }),
  );

  // Test/offline helper: plays the part of the buyer approving the order in the PayPal popup.
  router.post('/fake/approve/:id', (req, res) => {
    if (!orders.has(req.params.id)) return res.status(404).end();
    approvals.set(req.params.id, {
      email_address: req.body.email || 'buyer@example.com',
      payer_id: rid('PAYER'),
      name: { given_name: req.body.given || 'Ada', surname: req.body.surname || 'Buyer' },
    });
    res.json({ ok: true });
  });

  router.post('/fake/disputes', (req, res) => {
    const d = {
      dispute_id: rid('PP-D-'),
      status: req.body.status || 'OPEN',
      disputed_transactions: [{ seller_transaction_id: req.body.captureId }],
    };
    disputes.push(d);
    res.json(d);
  });

  router.post('/v2/checkout/orders/:id/capture', (req, res) =>
    once(req, res, () => {
      const order = orders.get(req.params.id);
      if (!order) return error(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID'), null;
      if (order.status === 'COMPLETED') return error(res, 422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED'), null;
      const payer = approvals.get(order.id);
      if (!payer) return error(res, 422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED'), null;
      const unit = order.purchase_units[0];
      const capture = {
        id: rid('3C'),
        status: 'COMPLETED',
        amount: unit.amount,
        final_capture: true,
        create_time: new Date().toISOString(),
        update_time: new Date().toISOString(),
        invoice_id: unit.invoice_id,
        custom_id: unit.custom_id,
      };
      unit.payments = { captures: [capture], refunds: [] };
      order.status = 'COMPLETED';
      order.payer = payer;
      captures.set(capture.id, order.id);
      return { status: 201, body: order };
    }),
  );

  router.get('/v2/checkout/orders/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) return error(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    res.json(order);
  });

  router.post('/v2/payments/captures/:id/refund', (req, res) =>
    once(req, res, () => {
      const orderId = captures.get(req.params.id);
      if (!orderId) return error(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID'), null;
      const unit = orders.get(orderId).purchase_units[0];
      const capture = unit.payments.captures[0];
      const refunded = unit.payments.refunds.reduce((s, r) => s + toCents(r.amount.value), 0);
      const amount = req.body.amount ? toCents(req.body.amount.value) : toCents(capture.amount.value) - refunded;
      if (req.body.amount && req.body.amount.currency_code !== capture.amount.currency_code) {
        return error(res, 422, 'UNPROCESSABLE_ENTITY', 'REFUND_CURRENCY_MISMATCH'), null;
      }
      if (amount <= 0 || refunded + amount > toCents(capture.amount.value)) {
        return error(res, 422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED'), null;
      }
      const refund = {
        id: rid('1R'),
        status: 'COMPLETED',
        amount: { value: toValue(amount), currency_code: capture.amount.currency_code },
        invoice_id: req.body.invoice_id,
        note_to_payer: req.body.note_to_payer,
        create_time: new Date().toISOString(),
      };
      unit.payments.refunds.push(refund);
      capture.status = refunded + amount === toCents(capture.amount.value) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      return { status: 201, body: refund };
    }),
  );

  // Like the sandbox seen on 2026-11-04, the transaction filter can be switched to answer 400.
  let filterBroken = false;
  router.post('/fake/break-dispute-filter', (req, res) => {
    filterBroken = true;
    res.json({ ok: true });
  });

  router.get('/v1/customer/disputes', (req, res) => {
    const tx = req.query.disputed_transaction_id;
    if (tx === undefined) {
      // The unfiltered list returns summaries; transaction details come from the dispute itself.
      return res.json({ items: disputes.map(({ disputed_transactions, ...summary }) => summary), links: [] });
    }
    if (filterBroken) return error(res, 400, 'INVALID_REQUEST', 'INVALID_REQUEST');
    res.json({ items: disputes.filter((d) => d.disputed_transactions.some((t) => t.seller_transaction_id === tx)) });
  });

  router.get('/v1/customer/disputes/:id', (req, res) => {
    const d = disputes.find((x) => x.dispute_id === req.params.id);
    if (!d) return error(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    res.json(d);
  });

  router.post('/v1/notifications/verify-webhook-signature', (req, res) => {
    res.json({ verification_status: req.body.transmission_sig === 'fake-valid' ? 'SUCCESS' : 'FAILURE' });
  });

  return { router, orders, disputes };
}
