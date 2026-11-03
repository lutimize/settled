import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Desk, DeskError } from './desk.js';
import { PRODUCTS, SELLER, DEFAULT_POLICY_TEXT } from './catalog.js';
import { toCents, formatMoney } from './money.js';
import { PayPalError } from './paypal.js';
import { RuleSchema } from './schemas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function rateLimiter(limitPerHour) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= limitPerHour) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function caseView(c) {
  if (!c) return null;
  const { token, ...rest } = c;
  return rest;
}

export function createApp({ config, store, paypal, ai, fakePayPal = null }) {
  const desk = new Desk({ store, paypal, ai, config });
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  if (!store.policy.text) store.setPolicy({ text: DEFAULT_POLICY_TEXT });

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  if (fakePayPal) app.use('/__fake_paypal', fakePayPal.router);

  // Webhooks need the body exactly as PayPal sent it for signature verification.
  app.post('/api/webhooks/paypal', express.json({ limit: '200kb' }), wrap(async (req, res) => {
    if (!config.paypal.webhookId && config.paypal.mode === 'sandbox') {
      return res.status(503).json({ error: { code: 'webhooks_not_configured', message: 'Set PAYPAL_WEBHOOK_ID.' } });
    }
    const verification = await paypal.verifyWebhookSignature({
      headers: req.headers,
      webhookId: config.paypal.webhookId || 'fake-webhook',
      event: req.body,
    });
    if (verification.verification_status !== 'SUCCESS') {
      store.event('webhook', `Rejected webhook with a bad signature (${req.body?.event_type || 'unknown'})`);
      return res.status(400).json({ error: { code: 'bad_signature', message: 'Signature check failed.' } });
    }
    res.json(desk.handleWebhookEvent(req.body));
  }));

  app.use(express.json({ limit: '32kb' }));

  const supportLimit = rateLimiter(config.desk.supportRequestsPerHourPerIp);
  const compileLimit = rateLimiter(10);

  // ---------- public ----------
  app.get('/api/config', (req, res) => {
    res.json({
      paypalMode: config.paypal.mode,
      paypalClientId: config.paypal.mode === 'sandbox' ? config.paypal.clientId : null,
      aiMode: config.ai.mode,
      model: config.ai.mode === 'claude' ? config.ai.model : null,
      seller: SELLER,
      products: PRODUCTS,
      autoRefundLimit: formatMoney(config.desk.autoRefundLimitCents),
    });
  });

  app.post('/api/checkout/orders', wrap(async (req, res) => {
    res.status(201).json(await desk.createCheckout(String(req.body.productId || '')));
  }));

  app.post('/api/checkout/orders/:id/capture', wrap(async (req, res) => {
    const sale = await desk.captureCheckout(req.params.id);
    res.json({
      orderId: sale.orderId,
      invoiceId: sale.invoiceId,
      productName: sale.productName,
      amount: formatMoney(sale.amountCents, sale.currency),
      payerEmail: sale.payerEmail,
      licenseKey: sale.licenseKey,
    });
  }));

  app.post('/api/licenses/:key/activate', (req, res) => {
    const sale = desk.activateLicense(req.params.key);
    res.json({ licenseKey: sale.licenseKey, activatedAt: sale.activatedAt });
  });

  app.post('/api/support/requests', (req, res) => {
    if (!supportLimit(req.ip)) throw new DeskError('Too many requests from this network. Try again later.', 429, 'rate_limited');
    const c = desk.openCase(req.body || {});
    res.status(201).json({ id: c.id, token: c.token });
  });

  app.get('/api/support/requests/:id', (req, res) => {
    res.json(desk.publicView(req.params.id, req.query.token));
  });

  // ---------- seller desk ----------
  app.get('/api/desk/cases', (req, res) => {
    res.json(store.listCases().map((c) => ({
      id: c.id,
      status: c.status,
      createdAt: c.createdAt,
      invoiceId: c.invoiceId,
      productName: c.productName,
      email: c.email,
      summary: c.triage?.summary || c.message.slice(0, 120),
      action: c.decision?.action || null,
      amountCents: c.decision?.amountCents ?? null,
      route: c.decision?.route || null,
    })));
  });

  app.get('/api/desk/cases/:id', (req, res) => {
    const c = store.getCase(req.params.id);
    if (!c) throw new DeskError('Case not found.', 404, 'case_not_found');
    res.json({ ...caseView(c), sale: store.findSaleByOrderId(c.orderId) });
  });

  app.post('/api/desk/cases/:id/approve', wrap(async (req, res) => {
    let amountCents;
    if (req.body.amount !== undefined && req.body.amount !== '') {
      try {
        amountCents = toCents(req.body.amount);
      } catch {
        throw new DeskError('Enter the amount like 14.50.', 400, 'bad_amount');
      }
    }
    res.json(caseView(await desk.approve(req.params.id, { amountCents, replyBody: req.body.replyBody })));
  }));

  app.post('/api/desk/cases/:id/decline', (req, res) => {
    res.json(caseView(desk.decline(req.params.id, { replyBody: req.body.replyBody })));
  });

  app.get('/api/desk/policy', (req, res) => res.json(store.policy));

  app.post('/api/desk/policy/compile', wrap(async (req, res) => {
    if (!compileLimit(req.ip)) throw new DeskError('Too many compiles from this network. Try again later.', 429, 'rate_limited');
    res.json(await desk.compilePolicy(req.body.text));
  }));

  app.post('/api/desk/policy/approve', (req, res) => {
    let rules;
    if (req.body.rules !== undefined) {
      const parsed = RuleSchema.array().safeParse(req.body.rules);
      if (!parsed.success) throw new DeskError('Rules are not in the expected shape.', 400, 'bad_rules');
      rules = parsed.data;
    }
    res.json(desk.approvePolicy(rules));
  });

  app.get('/api/desk/sales', (req, res) => {
    res.json(store.state.sales.slice(-30).reverse());
  });

  app.post('/api/desk/sales/:orderId/backdate', (req, res) => {
    res.json(desk.backdateSale(req.params.orderId, req.body.days));
  });

  app.get('/api/desk/events', (req, res) => res.json(store.state.events.slice(0, 60)));

  // ---------- offline helpers (PAYPAL_MODE=fake only) ----------
  if (fakePayPal) {
    app.post('/api/fake/approve/:id', wrap(async (req, res) => {
      const r = await fetch(`${paypal.apiBase}/fake/approve/${encodeURIComponent(req.params.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    }));
    app.post('/api/fake/dispute/:orderId', wrap(async (req, res) => {
      const sale = store.findSaleByOrderId(req.params.orderId);
      if (!sale) throw new DeskError('Order not found.', 404, 'order_not_found');
      const r = await fetch(`${paypal.apiBase}/fake/disputes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captureId: sale.captureId }),
      });
      res.json(await r.json());
    }));
  }

  // ---------- pages ----------
  app.use('/vendor/geist', express.static(path.join(root, 'node_modules/geist/dist/fonts'), { maxAge: '7d' }));
  app.use('/vendor/phosphor', express.static(path.join(root, 'node_modules/@phosphor-icons/web/src'), { maxAge: '7d' }));
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    if (err instanceof DeskError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof PayPalError) {
      console.warn('PayPal error', err.message, err.debugId || '');
      return res.status(502).json({ error: { code: 'paypal_error', message: 'PayPal returned an error. Try again.' } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong.' } });
  });

  return { app, desk };
}
