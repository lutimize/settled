// The demo store's catalog. Prices live only here; the browser never sends an amount.

export const SELLER = {
  name: 'Larkspur Apps',
  product: 'Quiet Hours',
  supportEmail: 'support@larkspur.example',
};

export const PRODUCTS = [
  {
    id: 'quiet-hours-pro',
    name: 'Quiet Hours Pro',
    blurb: 'Lifetime license for one computer. Focus timer, site blocker and weekly report.',
    priceCents: 2900,
    currency: 'USD',
  },
  {
    id: 'quiet-hours-team',
    name: 'Quiet Hours Team',
    blurb: 'Five licenses with a shared admin page. For small studios and classrooms.',
    priceCents: 11900,
    currency: 'USD',
  },
];

export function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

export const DEFAULT_POLICY_TEXT = `Refund policy for Quiet Hours (Larkspur Apps)

1. Bought twice by accident? We refund the duplicate order in full, at any time.
2. If you changed your mind or bought by mistake, you get a full refund within 14 days of purchase, as long as the license has not been activated.
3. If the license was already activated, we refund 50% within 14 days of purchase.
4. If Quiet Hours does not work on your computer, we refund in full within 30 days of purchase. We will ask what went wrong first, so a person reviews these.
5. If you tell us you did not make this purchase, we do not refund it here. A person will contact you and point you to PayPal so the payment can be investigated.
6. After 30 days we do not offer refunds, except for duplicate orders.`;
