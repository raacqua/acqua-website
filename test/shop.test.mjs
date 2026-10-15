import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveSku } from "../lib/catalog.js";
import { issueTravelEsim, templateFor } from "../lib/bridge.js";
import * as mail from "../lib/mail.js";
import checkoutHandler from "../api/checkout.js";

test("resolveSku prices travel and UK items from the catalog", () => {
  const it = resolveSku("travel", "italy-5gb-30d");
  assert.equal(it.unitAmount, 499);
  assert.equal(it.currency, "USD");
  assert.equal(it.mode, "payment");
  assert.equal(resolveSku("travel", "italy-7gb-30d"), null);      // size not sold
  assert.equal(resolveSku("travel", "italy-5gb-7d"), null);       // wrong validity
  assert.equal(resolveSku("travel", "../../etc"), null);
  const uk = resolveSku("uk", "uk-30");
  assert.equal(uk.unitAmount, 1500);
  assert.equal(uk.mode, "subscription");
  assert.equal(resolveSku("uk", "uk-999"), null);
});

test("checkout rejects bad input and reports when Stripe is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const handler = checkoutHandler;
  const res = mockRes();
  await handler({ method: "POST", body: { kind: "travel", sku: "italy-5gb-30d", email: "a@b.co" } }, res);
  assert.equal(res.statusCode, 503);
  const res2 = mockRes();
  await handler({ method: "GET" }, res2);
  assert.equal(res2.statusCode, 405);
});

test("bridge client maps affectPackageToSubscriber reply to eSIM details", async () => {
  // fake OCS server
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(b) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: { code: 0, msg: "OK" }, affectPackageToSubscriber: {
        iccid: "893720401615000106", smdpServer: "smdp.io", activationCode: "K2-1JL898-DKUTDC",
        urlQrCode: "LPA:1$smdp.io$K2-1JL898-DKUTDC", subscriberId: 18331, esimId: 37147, subsPackageId: 414 } }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.OCS_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.OCS_TOKEN = "tok";
  process.env.OCS_ACCOUNT_ID = "42";
  // unmapped SKU → manual
  const none = await issueTravelEsim({ sku: "italy-5gb-30d", days: 30 });
  assert.equal(none.ok, false);
  assert.equal(templateFor("italy-5gb-30d"), null);
  // mapped SKU → provisioned
  const r = await issueTravelEsim({ sku: "italy-5gb-30d", days: 30, templates: { "italy-5gb-30d": 553 } });
  srv.close();
  assert.equal(r.ok, true);
  assert.equal(r.lpa, "LPA:1$smdp.io$K2-1JL898-DKUTDC");
  assert.equal(seen[0].url, "/v1?token=tok");
  assert.deepEqual(seen[0].body, { affectPackageToSubscriber: { packageTemplateId: 553, accountForSubs: 42 } });
});

test("eSIM email renders a QR attachment and manual-entry details", async () => {
  const sent = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { sent.push(JSON.parse(b)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ MessageID: "m1" })); }); });
  await new Promise((r) => srv.listen(0, r));
  process.env.POSTMARK_SERVER_TOKEN = "pm";
  // point Postmark at the fake server
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => realFetch(String(u).replace("https://api.postmarkapp.com", `http://127.0.0.1:${srv.address().port}`), o);
  await mail.sendEsimEmail({ to: "t@x.io", orderRef: "ABC123", item: resolveSku("travel", "italy-5gb-30d"), esim: { iccid: "8937", smdpServer: "smdp.io", activationCode: "K2-X", lpa: "LPA:1$smdp.io$K2-X", days: 30 } });
  globalThis.fetch = realFetch; srv.close();
  const m = sent[0];
  assert.equal(m.To, "t@x.io");
  assert.match(m.Subject, /Italy eSIM is ready/);
  assert.equal(m.Attachments[0].ContentID, "cid:qr.png");
  assert.ok(m.Attachments[0].Content.length > 500);
  assert.match(m.HtmlBody, /K2-X/);
  assert.match(m.TextBody, /LPA:1\$smdp\.io\$K2-X/);
});

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

test("webhook fulfils a paid travel order once: Bridge issue → QR email → internal email → idempotent", async () => {
  const { fulfilSession } = await import("../api/stripe-webhook.js");
  // fake OCS + fake Postmark on one server
  const calls = { ocs: [], mail: [] };
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1")) { calls.ocs.push(JSON.parse(b)); res.end(JSON.stringify({ status: { code: 0, msg: "OK" }, affectPackageToSubscriber: { iccid: "8937001", smdpServer: "smdp.io", activationCode: "AC-1", urlQrCode: "LPA:1$smdp.io$AC-1", subscriberId: 7, esimId: 8, subsPackageId: 9 } })); }
    else { calls.mail.push(JSON.parse(b)); res.end(JSON.stringify({ MessageID: "x" })); }
  }); });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  Object.assign(process.env, { OCS_BASE_URL: base, OCS_TOKEN: "t", OCS_ACCOUNT_ID: "5", POSTMARK_SERVER_TOKEN: "pm", ORDERS_NOTIFY: "ops@acqua.test" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => realFetch(String(u).replace("https://api.postmarkapp.com", base), o);

  const pi = { id: "pi_1", metadata: {} };
  const stripe = { paymentIntents: { retrieve: async () => pi, update: async (id, { metadata }) => Object.assign(pi.metadata, metadata) } };
  const session = { id: "cs_test_abcdefghij1234", mode: "payment", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "buyer@x.io" }, metadata: { kind: "travel", sku: "italy-5gb-30d", sim_type: "esim" } };

  // unmapped template → manual path (pending email + action email), no OCS call
  const r0 = await fulfilSession(stripe, session);
  assert.equal(r0.delivered, false);
  assert.equal(calls.ocs.length, 0);
  assert.equal(calls.mail.length, 2);
  assert.match(calls.mail[0].Subject, /order is confirmed/);
  assert.match(calls.mail[1].Subject, /ACTION/);
  assert.equal(pi.metadata.fulfillment, "manual");

  // now map the template and reset → delivered path
  const fs = await import("node:fs");
  const mapPath = new URL("../data/bridge-templates.json", import.meta.url);
  const origMap = fs.readFileSync(mapPath, "utf8");
  fs.writeFileSync(mapPath, JSON.stringify({ templates: { "italy-5gb-30d": 553 } }));
  pi.metadata = {}; calls.mail.length = 0;
  try {
    const r1 = await fulfilSession(stripe, session);
    assert.equal(r1.delivered, true);
    assert.deepEqual(calls.ocs[0], { affectPackageToSubscriber: { packageTemplateId: 553, accountForSubs: 5 } });
    assert.equal(calls.mail[0].To, "buyer@x.io");
    assert.match(calls.mail[0].Subject, /Italy eSIM is ready/);
    assert.equal(calls.mail[1].To, "ops@acqua.test");
    assert.equal(pi.metadata.fulfillment, "done");
    assert.equal(pi.metadata.iccid, "8937001");
    // retry of the same event → no second eSIM, no second email
    const r2 = await fulfilSession(stripe, session);
    assert.equal(r2.already, "done");
    assert.equal(calls.ocs.length, 1);
    assert.equal(calls.mail.length, 2);
  } finally {
    fs.writeFileSync(mapPath, origMap);
    globalThis.fetch = realFetch; srv.close();
  }
});
