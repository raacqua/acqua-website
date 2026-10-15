// Single source of truth for what the shop sells: data/catalog.json.
// The page loads the same file, so the price the customer sees is the
// price the server charges. Never trust a price sent by the browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "data", "catalog.json"), "utf8"));

/** Resolve a SKU posted by the page into a priced line item, or null. */
export function resolveSku(kind, sku) {
  if (kind === "travel") {
    // sku: <destinationId>-<gb>gb-<days>d  e.g. "italy-5gb-30d"
    const m = /^([a-z0-9-]+)-(\d+)gb-(\d+)d$/.exec(sku || "");
    if (!m) return null;
    const [, destId, gb, days] = m;
    const dest = catalog.travel.destinations.find((d) => d.id === destId);
    if (!dest || Number(days) !== catalog.travel.days) return null;
    const price = dest.prices[gb];
    if (!price) return null;
    return {
      kind: "travel",
      sku,
      destId,
      destName: dest.name,
      gb: Number(gb),
      days: Number(days),
      currency: catalog.currencyTravel,
      unitAmount: Math.round(price * 100),
      name: `${dest.name} travel eSIM — ${gb}GB, ${days} days`,
      description: "QR code by email in minutes. Starts when you first connect abroad.",
      mode: "payment",
    };
  }
  if (kind === "uk") {
    const plan = catalog.uk.plans.find((p) => p.id === sku);
    if (!plan) return null;
    return {
      kind: "uk",
      sku,
      planLabel: plan.label,
      currency: catalog.uk.currency,
      unitAmount: Math.round(plan.price * 100),
      name: `UK ${plan.label} plan`,
      description: plan.note,
      mode: "subscription",
    };
  }
  return null;
}

export default catalog;
