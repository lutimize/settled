import express from 'express';
import { Store } from '../src/store.js';
import { PayPalClient } from '../src/paypal.js';
import { FakeDesk } from '../src/fake-ai.js';
import { createFakePayPal } from '../src/fake-paypal.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function startTestServer({ env = {} } = {}) {
  const fake = createFakePayPal();
  const fakeApp = express();
  fakeApp.use(fake.router);
  const fakeServer = await listen(fakeApp);
  const fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;

  const config = loadConfig({ PAYPAL_MODE: 'fake', AI_MODE: 'fake', ...env });
  const store = new Store(null);
  const ai = new FakeDesk();
  const paypal = new PayPalClient({ clientId: 'id', clientSecret: 'secret', apiBase: fakeBase });
  const { app, desk } = createApp({ config, store, paypal, ai });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // Buys a product end to end: create order, buyer approves (fake popup), capture.
  const buy = async (productId = 'quiet-hours-pro', email = 'mina@example.com') => {
    const created = await api('POST', '/api/checkout/orders', { productId });
    await fetch(`${fakeBase}/fake/approve/${created.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, given: 'Mina', surname: 'Park' }),
    });
    const captured = await api('POST', `/api/checkout/orders/${created.body.id}/capture`);
    return captured.body;
  };

  const approvePolicy = async () => {
    await api('POST', '/api/desk/policy/compile', { text: store.policy.text });
    return api('POST', '/api/desk/policy/approve', {});
  };

  const openAndWait = async (orderId, message, email = 'mina@example.com') => {
    const r = await api('POST', '/api/support/requests', { orderId, email, message });
    if (r.status !== 201) return r;
    await desk.pending.get(r.body.id);
    return { ...r, case: store.getCase(r.body.id) };
  };

  return {
    base,
    fakeBase,
    fake,
    store,
    desk,
    ai,
    api,
    buy,
    approvePolicy,
    openAndWait,
    close: () => {
      server.closeAllConnections();
      fakeServer.closeAllConnections();
      return Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fakeServer.close(r))]);
    },
  };
}
