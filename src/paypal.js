// Thin client for the PayPal REST APIs this app uses (sandbox only).
//   Orders v2:   create, capture, show order details
//   Payments v2: refund a captured payment, show refund
//   Disputes v1: list disputes for a transaction
//   Webhooks v1: verify a webhook signature

import { toCents, toValue } from './money.js';

export class PayPalError extends Error {
  constructor(message, { status, name, details, debugId } = {}) {
    super(message);
    this.status = status;
    this.paypalName = name;
    this.details = details;
    this.debugId = debugId;
  }
}

export class PayPalClient {
  constructor({ clientId, clientSecret, apiBase, fetchImpl = fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PayPalError(`PayPal auth failed (${res.status})`, { status: res.status, name: body.error });
    }
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + (body.expires_in || 300) * 1000;
    return this.token;
  }

  async request(method, pathname, { body, headers = {}, query } = {}) {
    const token = await this.accessToken();
    const url = new URL(this.apiBase + pathname);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new PayPalError(`PayPal ${method} ${pathname} returned a non-JSON response (${res.status})`, { status: res.status });
    }
    if (!res.ok) {
      const detail = data.details?.[0];
      throw new PayPalError(
        `PayPal ${method} ${pathname} failed: ${res.status} ${data.name || ''} ${detail?.issue || data.message || ''}`.trim(),
        { status: res.status, name: data.name, details: data.details, debugId: data.debug_id },
      );
    }
    return data;
  }

  createOrder({ product, invoiceId }) {
    return this.request('POST', '/v2/checkout/orders', {
      headers: { 'PayPal-Request-Id': `create-${invoiceId}` },
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: product.id,
            custom_id: product.id,
            invoice_id: invoiceId,
            description: product.name,
            amount: { currency_code: product.currency, value: toValue(product.priceCents) },
          },
        ],
      },
    });
  }

  captureOrder(orderId) {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      headers: { 'PayPal-Request-Id': `capture-${orderId}`, Prefer: 'return=representation' },
      body: {},
    });
  }

  getOrder(orderId) {
    return this.request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  refundCapture(captureId, { amountCents, currency, invoiceId, noteToPayer, requestId }) {
    return this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      headers: { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' },
      body: {
        amount: { value: toValue(amountCents), currency_code: currency },
        invoice_id: invoiceId,
        note_to_payer: noteToPayer?.slice(0, 255),
      },
    });
  }

  getRefund(refundId) {
    return this.request('GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
  }

  listDisputesForTransaction(transactionId) {
    return this.request('GET', '/v1/customer/disputes', { query: { disputed_transaction_id: transactionId } });
  }

  listDisputes() {
    return this.request('GET', '/v1/customer/disputes', { query: { page_size: '50' } });
  }

  getDispute(disputeId) {
    return this.request('GET', `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
  }

  verifyWebhookSignature({ headers, webhookId, event }) {
    return this.request('POST', '/v1/notifications/verify-webhook-signature', {
      body: {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
  }
}

// Reads the facts that matter for a refund decision out of a PayPal order.
// PayPal is the source of truth for money: amounts and prior refunds come from here, not from our store.
export function paymentFactsFromOrder(order) {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) return null;
  const refunds = unit.payments.refunds || [];
  const counted = refunds.filter((r) => ['COMPLETED', 'PENDING'].includes(r.status));
  const refundedCents = counted.reduce((sum, r) => sum + toCents(r.amount.value), 0);
  const capturedCents = toCents(capture.amount.value);
  return {
    orderId: order.id,
    orderStatus: order.status,
    captureId: capture.id,
    captureStatus: capture.status,
    capturedAt: capture.create_time,
    currency: capture.amount.currency_code,
    capturedCents,
    refundedCents,
    remainingCents: Math.max(0, capturedCents - refundedCents),
    refunds: refunds.map((r) => ({ id: r.id, status: r.status, cents: toCents(r.amount.value) })),
    payerEmail: order.payer?.email_address || null,
    payerName: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' ') || null,
    invoiceId: unit.invoice_id || null,
    productId: unit.custom_id || unit.reference_id || null,
  };
}

const OPEN_DISPUTE_STATUSES = new Set([
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'APPEALABLE',
]);

// Three states: { state: 'none' } | { state: 'open', ids } | { state: 'unknown', reason }.
// A failed lookup is never read as "no dispute".
export async function disputeStatus(paypal, captureId) {
  try {
    const data = await paypal.listDisputesForTransaction(captureId);
    const open = (data.items || []).filter((d) => OPEN_DISPUTE_STATUSES.has(d.status));
    if (open.length) return { state: 'open', ids: open.map((d) => d.dispute_id) };
    return { state: 'none', total: (data.items || []).length };
  } catch (err) {
    // The sandbox answers 400 INVALID_REQUEST to the transaction filter in some cases (seen 2026-11-04),
    // while the unfiltered list works. Fall back to scanning the seller's open disputes.
    if (!(err instanceof PayPalError && err.status === 400)) return { state: 'unknown', reason: err.message };
    try {
      return await scanOpenDisputes(paypal, captureId);
    } catch (err2) {
      return { state: 'unknown', reason: err2.message };
    }
  }
}

async function scanOpenDisputes(paypal, captureId) {
  const data = await paypal.listDisputes();
  if (data.links?.some((l) => l.rel === 'next')) throw new Error('Too many disputes to scan in one page.');
  const ids = [];
  for (const d of data.items || []) {
    if (!OPEN_DISPUTE_STATUSES.has(d.status)) continue;
    const txs = d.disputed_transactions || (await paypal.getDispute(d.dispute_id)).disputed_transactions || [];
    if (txs.some((t) => t.seller_transaction_id === captureId)) ids.push(d.dispute_id);
  }
  return ids.length ? { state: 'open', ids } : { state: 'none', scanned: (data.items || []).length };
}
