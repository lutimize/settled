// The refund desk: checkout, cases, decisions, refunds and webhooks.

import crypto from 'node:crypto';
import { findProduct, SELLER } from './catalog.js';
import { formatMoney } from './money.js';
import { paymentFactsFromOrder, disputeStatus, PayPalError } from './paypal.js';
import { decide, replyAmountsAreSafe, validateCompiledPolicy } from './policy.js';
import { AiError } from './ai.js';

export class DeskError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_MESSAGE = 2000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function firstName(name) {
  return (name || '').split(' ')[0] || 'there';
}

export class Desk {
  constructor({ store, paypal, ai, config, now = () => new Date() }) {
    this.store = store;
    this.paypal = paypal;
    this.ai = ai;
    this.config = config;
    this.now = now;
    this.refundLocks = new Set();
    this.captures = new Map(); // orderId -> in-flight capture, so a double submit issues one license
    this.pending = new Map(); // caseId -> processing promise (lets tests await background work)
  }

  // ---------------- checkout ----------------

  async createCheckout(productId) {
    const product = findProduct(productId);
    if (!product) throw new DeskError('Unknown product.', 404, 'unknown_product');
    const invoiceId = `LS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const order = await this.paypal.createOrder({ product, invoiceId });
    return { id: order.id };
  }

  captureCheckout(orderId) {
    if (!/^[A-Z0-9-]{5,64}$/i.test(orderId)) throw new DeskError('Invalid order id.');
    const existing = this.store.findSaleByOrderId(orderId);
    if (existing) return Promise.resolve(existing);
    if (!this.captures.has(orderId)) {
      const job = this.doCapture(orderId).finally(() => this.captures.delete(orderId));
      this.captures.set(orderId, job);
    }
    return this.captures.get(orderId);
  }

  async doCapture(orderId) {
    const captured = await this.paypal.captureOrder(orderId);
    const facts = paymentFactsFromOrder(captured);
    const product = findProduct(facts?.productId);
    if (!facts || !product) throw new DeskError('The order could not be matched to a product.', 422, 'order_mismatch');
    if (facts.captureStatus !== 'COMPLETED') {
      throw new DeskError(`Payment is ${facts.captureStatus}. No license was issued.`, 402, 'capture_not_completed');
    }
    if (facts.capturedCents !== product.priceCents || facts.currency !== product.currency) {
      throw new DeskError('Captured amount does not match the price.', 422, 'amount_mismatch');
    }
    const sale = {
      orderId: facts.orderId,
      captureId: facts.captureId,
      invoiceId: facts.invoiceId,
      productId: product.id,
      productName: product.name,
      amountCents: facts.capturedCents,
      currency: facts.currency,
      payerEmail: facts.payerEmail,
      payerName: facts.payerName,
      capturedAt: facts.capturedAt,
      licenseKey: `QH-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      activated: false,
      activatedAt: null,
      disputed: false,
      revoked: false,
    };
    this.store.addSale(sale);
    this.store.event('sale', `${product.name} sold to ${sale.payerEmail} (${formatMoney(sale.amountCents)})`, { orderId });
    return sale;
  }

  activateLicense(key) {
    const sale = this.store.findSaleByLicense(String(key || '').trim().toUpperCase());
    if (!sale) throw new DeskError('License not found.', 404, 'license_not_found');
    if (sale.revoked) throw new DeskError('This license was refunded and no longer works.', 409, 'license_revoked');
    if (!sale.activated) {
      this.store.updateSale(sale.orderId, { activated: true, activatedAt: this.now().toISOString() });
      this.store.event('activation', `License ${sale.licenseKey} activated`, { orderId: sale.orderId });
    }
    return sale;
  }

  // Lets the demo show a 20-day-old purchase without waiting 20 days. Only used from the desk's demo tools.
  backdateSale(orderId, days) {
    const sale = this.store.findSaleByOrderId(orderId);
    if (!sale) throw new DeskError('Order not found.', 404, 'order_not_found');
    const d = Math.max(0, Math.min(400, Number(days) || 0));
    this.store.updateSale(orderId, { backdateDays: d });
    return sale;
  }

  // ---------------- cases ----------------

  openCase({ orderId, email, message }) {
    orderId = String(orderId || '').trim().toUpperCase();
    email = String(email || '').trim();
    message = String(message || '').replace(/\r\n/g, '\n').replace(/\0/g, '').trim();
    if (!EMAIL_RE.test(email)) throw new DeskError('Enter the email address you paid with.', 400, 'invalid_email');
    if (message.length < 10) throw new DeskError('Tell us a little more about the problem.', 400, 'message_too_short');
    if (message.length > MAX_MESSAGE) throw new DeskError(`Keep the message under ${MAX_MESSAGE} characters.`, 400, 'message_too_long');

    const sale = this.store.findSaleByOrderId(orderId);
    // Same answer for "no such order" and "wrong email", so order ids cannot be probed.
    if (!sale || !sale.payerEmail || sale.payerEmail.toLowerCase() !== email.toLowerCase()) {
      throw new DeskError('We could not find an order with that ID and email.', 404, 'order_not_found');
    }
    const active = this.store
      .casesForOrder(orderId)
      .find((c) => ['reading', 'awaiting_approval', 'needs_human', 'refunding'].includes(c.status));
    if (active) throw new DeskError('There is already an open request for this order.', 409, 'case_open');

    const c = this.store.addCase({
      id: this.store.id('case'),
      token: crypto.randomBytes(16).toString('hex'),
      orderId,
      captureId: sale.captureId,
      invoiceId: sale.invoiceId,
      productName: sale.productName,
      email,
      customerName: sale.payerName,
      message,
      status: 'reading',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      facts: null,
      dispute: null,
      triage: null,
      decision: null,
      reply: null,
      refunds: [],
      log: [],
    });
    this.store.logCase(c.id, 'received', 'Request received from the support form.');
    const job = this.process(c.id).catch((err) => {
      this.store.updateCase(c.id, { status: 'needs_human' });
      this.store.logCase(c.id, 'error', `Processing failed: ${err.message}`);
    });
    this.pending.set(c.id, job);
    job.finally(() => this.pending.delete(c.id));
    return c;
  }

  async readPayment(sale) {
    try {
      const order = await this.paypal.getOrder(sale.orderId);
      const facts = paymentFactsFromOrder(order);
      if (facts && sale.backdateDays) {
        // Demo time travel: shift the purchase date the engine sees. Amounts still come from PayPal.
        facts.capturedAt = new Date(new Date(facts.capturedAt).getTime() - sale.backdateDays * 86_400_000).toISOString();
        facts.backdated = sale.backdateDays;
      }
      return facts;
    } catch (err) {
      return null;
    }
  }

  async process(caseId) {
    const c = this.store.getCase(caseId);
    const sale = this.store.findSaleByOrderId(c.orderId);

    const facts = await this.readPayment(sale);
    this.store.logCase(caseId, 'paypal', facts ? `Read order ${facts.orderId} from PayPal.` : 'Could not read the order from PayPal.');
    const dispute = sale.disputed ? { state: 'open', ids: ['(from webhook)'] } : await disputeStatus(this.paypal, sale.captureId);
    this.store.logCase(caseId, 'paypal', `Dispute check: ${dispute.state}.`);

    let triage = null;
    try {
      triage = await this.ai.triage({ message: c.message, productName: sale.productName });
      this.store.logCase(caseId, 'ai', `AI read the message as "${triage.reason}".`);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      this.store.logCase(caseId, 'ai', `AI reading failed: ${err.message}`);
    }

    // Only orders that are still paid for and still licensed count as the "other" copy of a duplicate.
    const others = this.store
      .salesForPayer(sale.payerEmail)
      .filter((s) => s.orderId !== sale.orderId && s.productId === sale.productId && !s.revoked);
    const previousRequests = this.store.casesForOrder(c.orderId).filter((x) => x.id !== caseId).length;
    const policy = this.store.policy.active;
    const decision = decide({
      policy,
      facts,
      dispute,
      triage,
      message: c.message,
      sale,
      duplicate: { found: others.length > 0, orderIds: others.map((s) => s.orderId) },
      previousRequests,
      autoRefundLimitCents: this.config.desk.autoRefundLimitCents,
      now: this.now(),
    });
    this.store.logCase(caseId, 'decision', `${decision.action}${decision.amountCents ? ` ${formatMoney(decision.amountCents)}` : ''} (${decision.route}): ${decision.why}`);

    const reply = await this.draftReply(c, sale, decision, triage);
    const status = decision.route === 'auto' ? 'refunding' : decision.route === 'approval' ? 'awaiting_approval' : 'needs_human';
    this.store.updateCase(caseId, { facts, dispute, triage, decision, reply, status });

    if (decision.route === 'auto') {
      try {
        await this.executeRefund(caseId, decision.amountCents, 'auto');
        this.sendReply(caseId, reply);
      } catch (err) {
        this.store.updateCase(caseId, { status: 'needs_human' });
        this.store.logCase(caseId, 'error', `Automatic refund stopped: ${err.message}`);
      }
    }
    return this.store.getCase(caseId);
  }

  templateReply(c, decision) {
    const hi = `Hi ${firstName(c.customerName)},\n\n`;
    const sign = `\n\n${SELLER.name} support`;
    if (decision.action === 'refund') {
      return {
        subject: `Your refund for ${c.productName}`,
        body: `${hi}Thanks for writing. We have issued a refund of ${formatMoney(decision.amountCents)} to your PayPal account for order ${c.invoiceId}.${sign}`,
        source: 'template',
      };
    }
    if (decision.action === 'deny') {
      const quote = decision.rule?.quote ? ` Our refund policy says: "${decision.rule.quote}"` : '';
      return {
        subject: `About your refund request for ${c.productName}`,
        body: `${hi}Thanks for writing.${quote} So we are not able to refund this order. If something in the app is not working, reply here and we will help.${sign}`,
        source: 'template',
      };
    }
    if (decision.action === 'declined') {
      return {
        subject: `About your refund request for ${c.productName}`,
        body: `${hi}Thanks for writing. We looked at your order and are not able to refund it. If something in the app is not working, reply here and we will help.${sign}`,
        source: 'template',
      };
    }
    return {
      subject: `We received your request about ${c.productName}`,
      body: `${hi}Thanks for writing. A person on our team will look at your request and reply to you soon.${sign}`,
      source: 'template',
    };
  }

  async draftReply(c, sale, decision, triage) {
    if (!triage) return this.templateReply(c, decision);
    const outcome =
      decision.action === 'refund'
        ? decision.route === 'auto'
          ? 'Refund issued'
          : 'Refund issued (the seller will confirm before sending)'
        : decision.action === 'deny'
          ? 'No refund'
          : 'Passed to a person on the team';
    try {
      const draft = await this.ai.draftReply({
        sellerName: SELLER.name,
        customerName: firstName(c.customerName),
        language: triage.language,
        outcome,
        amountText: decision.action === 'refund' ? formatMoney(decision.amountCents) : null,
        policyQuote: decision.action === 'deny' ? decision.rule?.quote : null,
        summary: triage.summary,
      });
      const allowedCents = decision.action === 'refund' ? [decision.amountCents] : [];
      if (!replyAmountsAreSafe(draft.body, { allowedCents })) {
        this.store.logCase(c.id, 'guard', 'AI draft mentioned an amount the decision does not allow; replaced with a template.');
        return this.templateReply(c, decision);
      }
      return { ...draft, source: 'ai' };
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      this.store.logCase(c.id, 'ai', `Reply draft failed (${err.message}); using a template.`);
      return this.templateReply(c, decision);
    }
  }

  sendReply(caseId, reply) {
    // The demo shows the reply on the customer's request page instead of sending email.
    this.store.updateCase(caseId, { sentReply: { ...reply, at: this.now().toISOString() } });
    this.store.logCase(caseId, 'reply', 'Reply sent to the customer.');
  }

  async executeRefund(caseId, amountCents, by) {
    const c = this.store.getCase(caseId);
    const sale = this.store.findSaleByOrderId(c.orderId);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DeskError('Refund amount must be above zero.');
    if (this.refundLocks.has(sale.captureId)) throw new DeskError('A refund for this payment is already running.', 409, 'refund_running');
    this.refundLocks.add(sale.captureId);
    try {
      // Re-read PayPal right before moving money; the earlier read may be stale.
      const facts = await this.readPayment(sale);
      if (!facts) throw new DeskError('PayPal could not be reached; nothing was refunded.', 503, 'paypal_unavailable');
      const requestId = `settled-${caseId}-${amountCents}`;
      // After a lost response, the same request is sent again; PayPal returns the original refund for a repeated
      // PayPal-Request-Id instead of paying twice, so the balance check (already reduced by it) is skipped.
      const replay = c.pendingRefund?.requestId === requestId;
      if (!replay && amountCents > facts.remainingCents) {
        throw new DeskError(`Only ${formatMoney(facts.remainingCents)} is left to refund on this payment.`, 422, 'over_balance');
      }
      const dispute = sale.disputed ? { state: 'open', ids: [] } : await disputeStatus(this.paypal, sale.captureId);
      if (dispute.state === 'open') throw new DeskError('This payment has an open PayPal dispute. Resolve it there.', 409, 'dispute_open');
      if (dispute.state === 'unknown' && by === 'auto') throw new DeskError('Dispute status unknown.', 409, 'dispute_unknown');

      this.store.updateCase(caseId, { status: 'refunding' });
      const refund = await this.paypal.refundCapture(sale.captureId, {
        amountCents,
        currency: facts.currency,
        invoiceId: `${c.invoiceId}-${caseId.slice(-6)}-R${c.refunds.length + 1}`,
        noteToPayer: `Refund for ${c.productName} (${c.invoiceId})`,
        requestId,
      });
      const record = { id: refund.id, status: refund.status, cents: amountCents, by, at: this.now().toISOString() };
      const refunds = [...c.refunds.filter((r) => r.id !== refund.id), record];
      this.store.updateCase(caseId, { refunds, status: 'refunded', pendingRefund: null });
      if ((replay ? facts.remainingCents : facts.remainingCents - amountCents) <= 0) {
        this.store.updateSale(sale.orderId, { revoked: true });
        this.store.logCase(caseId, 'license', `License ${sale.licenseKey} turned off (payment fully refunded).`);
      }
      this.store.logCase(caseId, 'refund', `PayPal refund ${refund.id} ${refund.status} for ${formatMoney(amountCents)} (${by}).`);
      this.store.event('refund', `Refunded ${formatMoney(amountCents)} on ${c.invoiceId} (${by})`, { caseId, refundId: refund.id });
      return record;
    } catch (err) {
      if (err instanceof DeskError) throw err;
      // Retrying later is safe: the same case and amount reuse the same PayPal-Request-Id.
      this.store.updateCase(caseId, { status: 'needs_human' });
      if (err instanceof PayPalError) {
        this.store.logCase(caseId, 'error', `PayPal refused the refund: ${err.message}`);
        throw new DeskError(`PayPal refused the refund (${err.paypalName || err.status}).`, 502, 'paypal_refund_failed');
      }
      this.store.updateCase(caseId, { pendingRefund: { requestId: `settled-${caseId}-${amountCents}`, cents: amountCents } });
      this.store.logCase(caseId, 'error', `Refund outcome unknown (${err.message}). Check PayPal, then retry; a retry cannot pay twice.`);
      throw new DeskError('The refund call did not finish. Check PayPal before retrying; a retry cannot pay twice.', 502, 'refund_unknown');
    } finally {
      this.refundLocks.delete(sale.captureId);
    }
  }

  async approve(caseId, { amountCents, replyBody }) {
    const c = this.store.getCase(caseId);
    if (!c) throw new DeskError('Case not found.', 404, 'case_not_found');
    if (!['awaiting_approval', 'needs_human'].includes(c.status)) {
      throw new DeskError(`This case is ${c.status.replace('_', ' ')}.`, 409, 'case_not_open');
    }
    const amount = amountCents ?? c.decision?.amountCents;
    await this.executeRefund(caseId, amount, 'seller');
    const reply =
      typeof replyBody === 'string' && replyBody.trim()
        ? { subject: c.reply?.subject || `Your refund for ${c.productName}`, body: replyBody.trim(), source: 'seller' }
        : amount === c.decision?.amountCents && c.decision?.action === 'refund'
          ? c.reply
          : this.templateReply(c, { action: 'refund', amountCents: amount });
    this.sendReply(caseId, reply);
    return this.store.getCase(caseId);
  }

  decline(caseId, { replyBody }) {
    const c = this.store.getCase(caseId);
    if (!c) throw new DeskError('Case not found.', 404, 'case_not_found');
    if (!['awaiting_approval', 'needs_human'].includes(c.status)) {
      throw new DeskError(`This case is ${c.status.replace('_', ' ')}.`, 409, 'case_not_open');
    }
    const edited = typeof replyBody === 'string' && replyBody.trim() && replyBody.trim() !== c.reply?.body?.trim();
    if (edited && !replyAmountsAreSafe(replyBody, { allowedCents: [] })) {
      throw new DeskError('The reply mentions an amount, but no refund is being made. Edit the reply first.', 422, 'reply_mentions_amount');
    }
    const reply = edited
      ? { subject: c.reply?.subject || `About your request for ${c.productName}`, body: replyBody.trim(), source: 'seller' }
      : c.decision?.action === 'deny'
        ? c.reply
        : this.templateReply(c, { action: 'declined' });
    this.store.updateCase(caseId, { status: 'closed' });
    this.store.logCase(caseId, 'closed', 'Closed by the seller without a refund.');
    this.sendReply(caseId, reply);
    return this.store.getCase(caseId);
  }

  publicView(caseId, token) {
    const c = this.store.getCase(caseId);
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
    if (!c || !token || !crypto.timingSafeEqual(digest(c.token), digest(token))) {
      throw new DeskError('Request not found.', 404, 'case_not_found');
    }
    const label = {
      reading: 'Reading your request',
      refunding: 'Issuing your refund',
      awaiting_approval: 'Waiting for the team to confirm',
      needs_human: 'A person on the team will reply',
      refunded: 'Refunded',
      closed: 'Answered',
    }[c.status];
    return {
      id: c.id,
      status: c.status,
      label,
      invoiceId: c.invoiceId,
      productName: c.productName,
      reply: c.sentReply ? { subject: c.sentReply.subject, body: c.sentReply.body, at: c.sentReply.at } : null,
      refunds: c.refunds.map((r) => ({ id: r.id, status: r.status, amount: formatMoney(r.cents) })),
    };
  }

  // ---------------- policy ----------------

  async compilePolicy(text) {
    text = String(text || '').replace(/\r\n/g, '\n').trim();
    if (text.length < 40) throw new DeskError('The policy is too short to compile.');
    if (text.length > 6000) throw new DeskError('Keep the policy under 6000 characters.');
    let compiled;
    try {
      compiled = await this.ai.compilePolicy(text);
    } catch (err) {
      if (err instanceof AiError) throw new DeskError(err.message, 503, 'ai_unavailable');
      throw err;
    }
    const validation = validateCompiledPolicy(compiled, text);
    this.store.setPolicy({ text, draft: { ...compiled, validation, compiledAt: this.now().toISOString() } });
    this.store.event('policy', `Policy compiled into ${compiled.rules.length} rules${validation.ok ? '' : ' (needs fixes)'}`);
    return this.store.policy;
  }

  approvePolicy(rules) {
    const { draft, text } = this.store.policy;
    if (!draft) throw new DeskError('Compile the policy first.', 409, 'no_draft');
    // The seller may adjust rule fields in the review table; validate again before anything is used.
    const candidate = { rules: Array.isArray(rules) ? rules : draft.rules, notes: draft.notes };
    const validation = validateCompiledPolicy(candidate, text);
    if (!validation.ok) throw new DeskError('Some rules need fixes before approval.', 422, 'policy_invalid');
    this.store.setPolicy({ active: { ...candidate, text, approvedAt: this.now().toISOString() } });
    this.store.event('policy', `Policy approved with ${candidate.rules.length} rules`);
    return this.store.policy;
  }

  // ---------------- webhooks ----------------

  handleWebhookEvent(event) {
    if (this.store.hasWebhook(event.id)) return { duplicate: true };
    this.applyWebhookEvent(event);
    this.store.rememberWebhook(event.id);
    return { duplicate: false };
  }

  applyWebhookEvent(event) {
    const r = event.resource || {};
    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.REFUNDED': {
        for (const c of this.store.listCases()) {
          const ref = c.refunds.find((x) => x.id === r.id);
          if (ref) {
            ref.status = r.status;
            this.store.updateCase(c.id, { refunds: c.refunds });
            this.store.logCase(c.id, 'webhook', `PayPal confirmed refund ${r.id}: ${r.status}.`);
          }
        }
        this.store.event('webhook', `PAYMENT.CAPTURE.REFUNDED ${r.id} ${r.status}`);
        break;
      }
      case 'CUSTOMER.DISPUTE.CREATED':
      case 'CUSTOMER.DISPUTE.UPDATED': {
        for (const t of r.disputed_transactions || []) {
          const sale = this.store.findSaleByCaptureId(t.seller_transaction_id);
          if (!sale) continue;
          const open = !['RESOLVED', 'DENIED', 'CLOSED'].includes(String(r.status || 'OPEN').toUpperCase());
          this.store.updateSale(sale.orderId, { disputed: open, disputeId: r.dispute_id });
          if (!open) continue;
          for (const c of this.store.casesForOrder(sale.orderId)) {
            if (['awaiting_approval', 'reading'].includes(c.status)) {
              this.store.updateCase(c.id, { status: 'needs_human' });
              this.store.logCase(c.id, 'webhook', `Buyer opened PayPal dispute ${r.dispute_id}; refunds are blocked here.`);
            }
          }
        }
        this.store.event('webhook', `${event.event_type} ${r.dispute_id || ''}`);
        break;
      }
      case 'CUSTOMER.DISPUTE.RESOLVED': {
        for (const t of r.disputed_transactions || []) {
          const sale = this.store.findSaleByCaptureId(t.seller_transaction_id);
          if (sale) this.store.updateSale(sale.orderId, { disputed: false });
        }
        this.store.event('webhook', `CUSTOMER.DISPUTE.RESOLVED ${r.dispute_id || ''}`);
        break;
      }
      default:
        this.store.event('webhook', `${event.event_type} (ignored)`);
    }
  }
}

