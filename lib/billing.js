/**
 * A real Checkout Session created per-installation at request time, not a
 * static payment link — same pattern as curbspec's startCheckoutSession
 * (src/app/actions/checkout.ts). A static link can't carry per-customer
 * metadata, and the webhook needs installationId to know whose
 * subscription just activated.
 */
async function createSubscribeCheckoutUrl(stripe, installationId, appBaseUrl) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    metadata: { installationId: String(installationId) },
    subscription_data: { metadata: { installationId: String(installationId) } },
    success_url: `${appBaseUrl}/?subscribed=success`,
    cancel_url: `${appBaseUrl}/?subscribed=cancelled`,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }
  return session.url;
}

module.exports = { createSubscribeCheckoutUrl };
