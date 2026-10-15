// Bridge4IP / eSIMVault OCS client — https://docs.esimvault.cloud/ocs-api
// Every request is  POST {OCS_BASE_URL}/v1?token={OCS_TOKEN}  with a JSON
// body of the form { "<requestName>": { ...params } } and a
// { status: { code, msg }, "<requestName>": {...} } answer (code 0 = OK).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./env.js";

const here = dirname(fileURLToPath(import.meta.url));

/** SKU → OCS prepaid package template id. Edit data/bridge-templates.json. */
export function loadTemplates() {
  return JSON.parse(readFileSync(join(here, "..", "data", "bridge-templates.json"), "utf8")).templates || {};
}
export function templateFor(sku, templates = loadTemplates()) {
  const id = templates[sku];
  return id ? Number(id) : null;
}

export async function ocs(requestName, params = {}) {
  const { baseUrl, token } = config.ocs;
  if (!baseUrl || !token) throw new Error("OCS not configured");
  const r = await fetch(`${baseUrl}/v1?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ [requestName]: params }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`OCS ${requestName}: non-JSON reply (${r.status}) ${text.slice(0, 200)}`); }
  if (!r.ok || !data.status || data.status.code !== 0) {
    throw new Error(`OCS ${requestName}: ${data.status?.code ?? r.status} ${data.status?.msg ?? text.slice(0, 200)}`);
  }
  return data[requestName];
}

/**
 * Take a free eSIM from Acqua's stock account, attach the package and
 * return what the customer needs to install it.
 * The package starts at first use (no validityPeriod sent), so the
 * configured perioddays on the template begins when the traveller connects.
 */
export async function issueTravelEsim({ sku, days, templates }) {
  const packageTemplateId = templateFor(sku, templates);
  if (!packageTemplateId) return { ok: false, reason: `no package template mapped for ${sku}` };
  const r = await ocs("affectPackageToSubscriber", {
    packageTemplateId,
    accountForSubs: config.ocs.accountId,
  });
  // r: { iccid, smdpServer, activationCode, urlQrCode, subscriberId, esimId, subsPackageId, userSimName }
  if (!r?.activationCode || !r?.smdpServer) return { ok: false, reason: "OCS reply missing activation code", raw: r };
  return {
    ok: true,
    iccid: r.iccid,
    smdpServer: r.smdpServer,
    activationCode: r.activationCode,
    lpa: r.urlQrCode || `LPA:1$${r.smdpServer}$${r.activationCode}`,
    subscriberId: r.subscriberId,
    esimId: r.esimId,
    subsPackageId: r.subsPackageId,
    packageTemplateId,
    days,
  };
}
