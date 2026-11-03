import { loadConfig, describeConfigProblems } from './config.js';
import { Store } from './store.js';
import { PayPalClient } from './paypal.js';
import { ClaudeDesk } from './ai.js';
import { FakeDesk } from './fake-ai.js';
import { createFakePayPal } from './fake-paypal.js';
import { createApp } from './server.js';

const config = loadConfig();
const problems = describeConfigProblems(config);
if (problems.length) {
  console.error('Settled cannot start:\n- ' + problems.join('\n- ') + '\nSee .env.example.');
  process.exit(1);
}

const store = new Store(config.dataDir);
const takeCall = () => store.takeAiCall(config.ai.dailyCallLimit);
const ai = config.ai.mode === 'claude' ? new ClaudeDesk({ model: config.ai.model, takeCall }) : new FakeDesk({ takeCall });

let fakePayPal = null;
let apiBase = config.paypal.apiBase;
if (config.paypal.mode === 'fake') {
  fakePayPal = createFakePayPal();
  apiBase = `http://127.0.0.1:${config.port}/__fake_paypal`;
}
const paypal = new PayPalClient({
  clientId: config.paypal.clientId || 'fake-client',
  clientSecret: config.paypal.clientSecret || 'fake-secret',
  apiBase,
});

const { app } = createApp({ config, store, paypal, ai, fakePayPal });
app.listen(config.port, config.host, () => {
  console.log(`Settled on http://localhost:${config.port}  (PayPal: ${config.paypal.mode}, AI: ${config.ai.mode})`);
});
