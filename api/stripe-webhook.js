// POST /api/stripe-webhook — Stripe sends checkout.session.completed here.
// Verifies the signature, then fulfils the order exactly once:
//   travel eSIM → issue on Bridge (eSIMVault) → email QR to the customer
//   UK plan / unmapped SKU → holding email to the customer + action email to the team
// Fulfilment state is kept in the PaymentIntent / Subscription metadata so
// Stripe's webhook retries never issue a second eSIM.
import Stripe from "stripe";
import { resolveSku } from "../lib/catalog.js";
import { config as app } from "../lib/env.js";
import { issueTravelEsim } from "../lib/bridge.js";
import { sendEsimEmail, sendPendingEmail, sendInternalEmail } from "../lib/mail.js";

// Web-standard handler (Request → Response): Vercel hands us the untouched
// body, which is what Stripe signed. The Node (req,res) style pre-parses it.
export async function POST(request) {
  const stripe = new Stripe(app.stripe.secretKey);
  let event;
  try {
    const raw = await request.text();
    event = stripe.webhooks.constructEvent(raw, request.headers.get("stripe-signature"), app.stripe.webhookSecret);
  } catch (e) {
    console.error("webhook signature failed", e.message);
    return new Response(`Webhook error: ${e.message}`, { status: 400 });
  }

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return Response.json({ received: true, ignored: event.type });
  }

  const result = await fulfilSession(stripe, event.data.object);
  return Response.json({ received: true, ...result });
}

/** Fulfil one Checkout Session. Exported for tests; `stripe` is any object with the SDK's shape. */
export async function fulfilSession(stripe, session) {
  if (session.payment_status !== "paid" && session.mode !== "subscription") return { waiting: session.payment_status };

  const md = session.metadata || {};
  const item = resolveSku(md.kind, md.sku);
  const customerEmail = session.customer_details?.email || md.customer_email || session.customer_email;
  const orderRef = session.id.replace("cs_live_", "").replace("cs_test_", "").slice(-10).toUpperCase();
  if (!item || !customerEmail) {
    console.error("session missing item/email", session.id, md);
    await safe(() => sendInternalEmail({ orderRef: session.id, item: { name: "UNKNOWN", sku: md.sku, unitAmount: session.amount_total || 0, currency: (session.currency || "").toUpperCase() }, customerEmail, error: "Could not resolve SKU or email from session metadata" }));
    return { unresolved: true };
  }

  // --- idempotency: claim the order on the Stripe object that outlives the session
  const target = session.mode === "subscription"
    ? { kind: "subscription", id: session.subscription }
    : { kind: "paymentIntent", id: session.payment_intent };
  const obj = target.kind === "subscription" ? await stripe.subscriptions.retrieve(target.id) : await stripe.paymentIntents.retrieve(target.id);
  const st = obj.metadata?.fulfillment || "";
  const startedAt = Number(obj.metadata?.fulfillment_at || 0);
  if (st === "done" || (st === "started" && Date.now() - startedAt < 5 * 60 * 1000)) {
    return { already: st };
  }
  await setMeta(stripe, target, { fulfillment: "started", fulfillment_at: String(Date.now()) });

  const extra = {
    "Stripe session": session.id,
    [target.kind === "subscription" ? "Subscription" : "PaymentIntent"]: target.id,
    "SIM type": md.sim_type || "esim",
    ...(session.shipping_details?.address ? { "Ship to": JSON.stringify(session.shipping_details.address) } : {}),
  };

  // --- fulfil
  let esim = null, error = null;
  if (item.kind === "travel" && md.sim_type !== "physical") {
    try {
      esim = await issueTravelEsim({ sku: item.sku, days: item.days });
      if (esim.ok) await sendEsimEmail({ to: customerEmail, orderRef, item, esim });
    } catch (e) {
      error = e.message;
      console.error("fulfilment error", session.id, e);
    }
  }
  const delivered = Boolean(esim?.ok) && !error;
  if (!delivered) await safe(() => sendPendingEmail({ to: customerEmail, orderRef, item }));
  await safe(() => sendInternalEmail({ orderRef, item, customerEmail, esim, error, extra }));

  await setMeta(stripe, target, {
    fulfillment: delivered ? "done" : "manual",
    fulfillment_note: delivered ? `iccid ${esim.iccid}` : (error || esim?.reason || "manual").slice(0, 480),
    ...(delivered ? { iccid: esim.iccid, ocs_subscriber: String(esim.subscriberId), ocs_package: String(esim.subsPackageId) } : {}),
  });
  return { delivered };
}


async function setMeta(stripe, target, metadata) {
  if (target.kind === "subscription") return stripe.subscriptions.update(target.id, { metadata });
  return stripe.paymentIntents.update(target.id, { metadata });
}

async function safe(fn) { try { return await fn(); } catch (e) { console.error("non-fatal", e.message); } }
