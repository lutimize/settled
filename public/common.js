// Shared helpers for every page.

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export function money(cents, currency = 'USD') {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${currency === 'USD' ? '$' : currency + ' '}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
export function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

let configPromise;
export function config() {
  configPromise ||= api('GET', '/api/config');
  return configPromise;
}

// Fills the strip under the top bar that says which PayPal and AI back this instance.
export async function modebar() {
  const el = document.querySelector('.modebar');
  if (!el) return;
  const c = await config();
  const paypal = c.paypalMode === 'sandbox' ? '<strong>PayPal sandbox</strong> (test money only)' : '<strong>Offline PayPal stand-in</strong> (no network)';
  const ai = c.aiMode === 'claude' ? `<strong>Claude</strong> <span class="mono">${esc(c.model)}</span>` : '<strong>Offline keyword AI</strong> (no model)';
  el.innerHTML = `Payments: ${paypal} &nbsp;&nbsp; AI: ${ai}`;
}

export const STATUS = {
  reading: { label: 'Reading', cls: '' },
  refunding: { label: 'Refunding', cls: 'ok' },
  awaiting_approval: { label: 'Needs your OK', cls: 'warn' },
  needs_human: { label: 'Needs a person', cls: 'fail' },
  refunded: { label: 'Refunded', cls: 'ok' },
  closed: { label: 'Answered', cls: '' },
};
