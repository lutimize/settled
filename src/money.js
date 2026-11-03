// Money is handled as integer cents everywhere inside the app.
// PayPal sends and receives decimal strings ("29.00"); convert only at the edge.

export function toCents(value) {
  const s = String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Not a money string: ${value}`);
  const negative = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function toValue(cents) {
  if (!Number.isInteger(cents)) throw new Error(`Cents must be an integer: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatMoney(cents, currency = 'USD') {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${toValue(cents)}`;
}

// Percent of an amount, rounded down to the cent so a percentage rule never pays more than it says.
export function percentOf(cents, percent) {
  return Math.floor((cents * percent) / 100);
}
