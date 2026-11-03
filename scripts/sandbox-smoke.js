// Checks the PayPal sandbox credentials and the Claude key without touching any buyer account.
// Usage: npm run smoke   (reads .env)
// Prints PASS/FAIL per step. Never prints a secret.

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config.js';
import { PayPalClient, disputeStatus } from '../src/paypal.js';
import { findProduct } from '../src/catalog.js';

const config = loadConfig();
let failed = 0;
async function step(name, fn) {
  try {
    const note = await fn();
    console.log(`PASS  ${name}${note ? `  (${note})` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}  ${err.message}`);
  }
}

if (config.paypal.mode !== 'sandbox') {
  console.log('PAYPAL_MODE is not "sandbox"; nothing to check.');
  process.exit(1);
}
const paypal = new PayPalClient(config.paypal);

await step('PayPal OAuth token (client id + secret)', async () => {
  await paypal.accessToken();
  return config.paypal.apiBase;
});

let orderId;
await step('Orders v2: create an order', async () => {
  const order = await paypal.createOrder({ product: findProduct('quiet-hours-pro'), invoiceId: `SMOKE-${Date.now()}` });
  orderId = order.id;
  return `order ${order.id}, status ${order.status}`;
});

await step('Orders v2: read it back', async () => {
  const order = await paypal.getOrder(orderId);
  return `status ${order.status}, amount ${order.purchase_units[0].amount.value} ${order.purchase_units[0].amount.currency_code}`;
});

await step('Disputes API: list disputes (needs the Disputes feature on the app)', async () => {
  const data = await paypal.listDisputes();
  return `${(data.items || []).length} items`;
});

await step('Dispute check the desk runs before a refund', async () => {
  const status = await disputeStatus(paypal, `SMOKE${Date.now()}`.slice(0, 17));
  if (status.state === 'unknown') throw new Error(status.reason);
  return `state ${status.state}`;
});

await step('Webhook id is set (optional)', async () => {
  if (!config.paypal.webhookId) throw new Error('PAYPAL_WEBHOOK_ID is empty; webhooks will answer 503. The app still works without them.');
  return 'set';
});

if (config.ai.mode === 'claude') {
  await step(`Claude key works (${config.ai.model})`, async () => {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: config.ai.model,
      max_tokens: 64,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the word ready.' }],
    });
    return `stop_reason ${res.stop_reason}`;
  });
}

console.log(failed ? `\n${failed} step(s) failed.` : '\nAll checks passed. Start the app with: npm start');
process.exit(failed ? 1 : 0);
