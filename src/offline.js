// Offline mode: in-memory PayPal stand-in and keyword "AI". For trying the UI without any keys.
process.env.PAYPAL_MODE = 'fake';
process.env.AI_MODE = 'fake';
process.env.DATA_DIR = process.env.DATA_DIR || './data-offline';
await import('./index.js');
