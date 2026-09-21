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
    success_url: `${appBaseUrl}/?subscribed=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appBaseUrl}/?subscribed=cancelled`,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }
  return session.url;
}

async function createPortalUrl(stripe, customerId, appBaseUrl) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: appBaseUrl,
    ...(process.env.STRIPE_PORTAL_CONFIG_ID && {
      configuration: process.env.STRIPE_PORTAL_CONFIG_ID,
    }),
  });
  if (!session.url) {
    throw new Error("Stripe did not return a portal URL.");
  }
  return session.url;
}

/**
 * Map Stripe events onto our subscriptions row. Checkout completion is the
 * fast path (customer just paid); subscription.* keeps cancel/renew in sync.
 */
async function applyStripeEvent(stripe, event, upsertSubscription) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const installationId = Number(session.metadata?.installationId);
    if (!installationId || session.mode !== "subscription" || !session.subscription) {
      return;
    }
    const subId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id;
    const sub = await stripe.subscriptions.retrieve(subId);
    await upsertSubscription({
      installationId,
      stripeCustomerId: String(sub.customer),
      stripeSubscriptionId: sub.id,
      status: sub.status,
    });
    return;
  }

  if (
    [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ].includes(event.type)
  ) {
    const sub = event.data.object;
    const installationId = Number(sub.metadata?.installationId);
    if (!installationId) return;
    await upsertSubscription({
      installationId,
      stripeCustomerId: String(sub.customer),
      stripeSubscriptionId: sub.id,
      status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
    });
  }
}

module.exports = {
  createSubscribeCheckoutUrl,
  createPortalUrl,
  applyStripeEvent,
};
