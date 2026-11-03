// A small JSON-file store. One process, writes are atomic (temp file + rename).
// Good enough for a single-instance demo; swap for a database before real use.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({
  sales: [],
  cases: [],
  policy: { text: null, draft: null, active: null },
  events: [],
  webhookEventIds: [],
  counters: { aiCallsDay: '', aiCalls: 0 },
});

export class Store {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'state.json') : null;
    this.state = EMPTY();
    if (this.file) {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        this.state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      }
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  id(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  }

  // ---- sales ----
  addSale(sale) {
    this.state.sales.push(sale);
    this.save();
    return sale;
  }
  findSaleByOrderId(orderId) {
    return this.state.sales.find((s) => s.orderId === orderId) || null;
  }
  findSaleByCaptureId(captureId) {
    return this.state.sales.find((s) => s.captureId === captureId) || null;
  }
  findSaleByLicense(key) {
    return this.state.sales.find((s) => s.licenseKey === key) || null;
  }
  salesForPayer(email) {
    const e = String(email || '').toLowerCase();
    return this.state.sales.filter((s) => s.payerEmail && s.payerEmail.toLowerCase() === e);
  }
  updateSale(orderId, patch) {
    const sale = this.findSaleByOrderId(orderId);
    if (!sale) return null;
    Object.assign(sale, patch);
    this.save();
    return sale;
  }

  // ---- cases ----
  addCase(c) {
    this.state.cases.unshift(c);
    this.save();
    return c;
  }
  getCase(id) {
    return this.state.cases.find((c) => c.id === id) || null;
  }
  listCases() {
    return this.state.cases;
  }
  casesForOrder(orderId) {
    return this.state.cases.filter((c) => c.orderId === orderId);
  }
  updateCase(id, patch) {
    const c = this.getCase(id);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return c;
  }
  logCase(id, kind, text, data) {
    const c = this.getCase(id);
    if (!c) return;
    c.log.push({ at: new Date().toISOString(), kind, text, ...(data ? { data } : {}) });
    this.save();
  }

  // ---- policy ----
  get policy() {
    return this.state.policy;
  }
  setPolicy(patch) {
    Object.assign(this.state.policy, patch);
    this.save();
  }

  // ---- audit events ----
  event(kind, text, data) {
    this.state.events.unshift({ at: new Date().toISOString(), kind, text, ...(data ? { data } : {}) });
    this.state.events = this.state.events.slice(0, 300);
    this.save();
  }

  hasWebhook(eventId) {
    return this.state.webhookEventIds.includes(eventId);
  }

  // Returns false when the webhook event id was already processed.
  rememberWebhook(eventId) {
    if (this.state.webhookEventIds.includes(eventId)) return false;
    this.state.webhookEventIds.push(eventId);
    this.state.webhookEventIds = this.state.webhookEventIds.slice(-500);
    this.save();
    return true;
  }

  // Global daily budget for model calls on a public demo.
  takeAiCall(limit, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const c = this.state.counters;
    if (c.aiCallsDay !== day) {
      c.aiCallsDay = day;
      c.aiCalls = 0;
    }
    if (c.aiCalls >= limit) return false;
    c.aiCalls += 1;
    this.save();
    return true;
  }
}
