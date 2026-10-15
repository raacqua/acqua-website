#!/usr/bin/env node
// Lists what the Bridge/eSIMVault account offers so data/bridge-templates.json can be filled in.
//   OCS_BASE_URL=https://... OCS_TOKEN=... node scripts/ocs-templates.mjs            → package templates
//   OCS_BASE_URL=https://... OCS_TOKEN=... node scripts/ocs-templates.mjs accounts   → accounts + free eSIM counts
import { ocs } from "../lib/bridge.js";

const mode = process.argv[2] || "templates";
const gb = (b) => (b ? (b / 1073741824).toFixed(b % 1073741824 ? 1 : 0) + "GB" : "-");

if (mode === "accounts") {
  const r = await ocs("listResellerAccount", {});
  for (const res of r.reseller || []) {
    console.log(`Reseller ${res.id}  ${res.name}`);
    for (const a of res.account || []) console.log(`   account ${a.id}  ${a.name}  balance ${a.balance}  packageOnly=${a.packageOnly}`);
  }
  const s = await ocs("esimStatusPerAccount", {}).catch(() => null);
  for (const a of s?.account || []) {
    const counts = (a.sponsor || []).flatMap((sp) => (sp.esim?.status || []).map((x) => `${sp.name}: ${x.statusStr}=${x.count}`));
    console.log(`eSIMs in account ${a.id} ${a.name}: ${counts.join(", ") || "none"}`);
  }
} else {
  const r = await ocs("listPrepaidPackageTemplate", {});
  const rows = (r.template || []).filter((t) => !t.deleted).map((t) => ({
    id: t.prepaidpackagetemplateid, name: t.prepaidpackagetemplatename, zone: t.rdbLocationZones?.locationzonename,
    data: gb(t.databyte), days: t.perioddays, cost: t.cost, sponsor: t.sponsors?.sponsorname,
  }));
  rows.sort((a, b) => String(a.zone).localeCompare(String(b.zone)) || a.id - b.id);
  console.table(rows);
  console.log(`\n${rows.length} templates. Put the ids into data/bridge-templates.json as "<destination-id>-<gb>gb-30d": <id>`);
}
