// POST /api/checkout  { kind: "travel"|"uk", sku, email, simType? }
// → { url } of a Stripe Checkout Session. The page redirects the buyer there.
import Stripe from "stripe";
import { resolveSku } from "../lib/catalog.js";
import { config, status } from "../lib/env.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!status().stripe) return res.status(503).json({ error: "Checkout isn't connected on this page yet. Email ra@acquatelecom.com to order." });

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  const { kind, sku, email, simType } = body;
  const item = resolveSku(kind, sku);
  if (!item) return res.status(400).json({ error: "That plan isn't available. Please pick another." });
  if (!EMAIL_RE.test(email || "")) return res.status(400).json({ error: "Enter a valid email address for your eSIM." });

  const stripe = new Stripe(config.stripe.secretKey, { apiVersion: "2025-08-27.basil" });
  const site = config.siteUrl;
  const metadata = {
    kind: item.kind,
    sku: item.sku,
    sim_type: item.kind === "uk" ? (simType === "physical" ? "physical" : "esim") : "esim",
    customer_email: email,
    dest: item.destId || "",
    gb: String(item.gb || ""),
    days: String(item.days || ""),
    plan: item.planLabel || "",
    source: "acquatelecom.com",
  };

  const lineItem = {
    quantity: 1,
    price_data: {
      currency: item.currency.toLowerCase(),
      unit_amount: item.unitAmount,
      product_data: { name: item.name, description: item.description },
      ...(item.mode === "subscription" ? { recurring: { interval: "month" } } : {}),
    },
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: item.mode,
      customer_email: email,
      line_items: [lineItem],
      metadata,
      ...(item.mode === "payment"
        ? { payment_intent_data: { metadata, description: item.name } }
        : { subscription_data: { metadata, description: item.name } }),
      // Physical SIM needs a postal address
      ...(metadata.sim_type === "physical" ? { shipping_address_collection: { allowed_countries: ["GB"] } } : {}),
      allow_promotion_codes: true,
      success_url: `${site}/?order=success&session_id={CHECKOUT_SESSION_ID}#shop`,
      cancel_url: `${site}/?order=cancelled#shop`,
      consent_collection: { terms_of_service: "none" },
      custom_text: {
        submit: { message: item.kind === "travel"
          ? "Your eSIM QR code is emailed within minutes of payment. Check that your phone supports eSIM."
          : "We'll email your SIM details shortly after payment." },
      },
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    return res.status(502).json({ error: "Checkout isn't available right now. Please try again in a moment." });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
