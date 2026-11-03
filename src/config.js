// Runtime configuration. Every secret comes from the environment; nothing is hardcoded.

function money(value, fallback) {
  const s = String(value ?? fallback).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid money value: ${s}`);
  return Math.round(Number(s) * 100);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid integer: ${value}`);
  return n;
}

export function loadConfig(env = process.env) {
  const paypalMode = (env.PAYPAL_MODE || 'sandbox').toLowerCase();
  if (!['sandbox', 'fake'].includes(paypalMode)) {
    // Live mode is deliberately not supported: this is a sandbox-only demo.
    throw new Error('PAYPAL_MODE must be "sandbox" or "fake".');
  }
  const aiMode = (env.AI_MODE || 'claude').toLowerCase();
  if (!['claude', 'fake'].includes(aiMode)) throw new Error('AI_MODE must be "claude" or "fake".');

  return {
    port: int(env.PORT, '3000'),
    // Loopback by default; hosts like Render set HOST=0.0.0.0.
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || './data',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    paypal: {
      mode: paypalMode,
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      webhookId: env.PAYPAL_WEBHOOK_ID || '',
      apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    },
    ai: {
      mode: aiMode,
      model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
      dailyCallLimit: int(env.AI_DAILY_CALL_LIMIT, '400'),
    },
    desk: {
      // Refunds at or below this amount may run without a human click, if every check passes.
      autoRefundLimitCents: money(env.AUTO_REFUND_LIMIT, '30.00'),
      supportRequestsPerHourPerIp: int(env.SUPPORT_REQUESTS_PER_HOUR, '12'),
    },
  };
}

export function describeConfigProblems(config) {
  const problems = [];
  if (config.paypal.mode === 'sandbox' && (!config.paypal.clientId || !config.paypal.clientSecret)) {
    problems.push('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required (sandbox app credentials).');
  }
  if (config.paypal.mode === 'sandbox' && !/sandbox/.test(config.paypal.apiBase)) {
    problems.push('PAYPAL_API_BASE must point at the PayPal sandbox.');
  }
  if (config.ai.mode === 'claude' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    problems.push('ANTHROPIC_API_KEY is required for AI_MODE=claude.');
  }
  return problems;
}
