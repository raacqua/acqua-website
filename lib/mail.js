// Transactional email via Postmark's REST API (no SDK needed).
import QRCode from "qrcode";
import { config } from "./env.js";

async function send(msg) {
  const token = config.mail.postmarkToken;
  if (!token) throw new Error("Postmark not configured");
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({ From: config.mail.from, ReplyTo: config.mail.replyTo, MessageStream: "outbound", ...msg }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ErrorCode) throw new Error(`Postmark: ${data.ErrorCode ?? r.status} ${data.Message ?? ""}`);
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const shell = (title, body) => `<!doctype html><html><body style="margin:0;background:#f4f6f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0b1414">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<div style="background:#fff;border-radius:16px;padding:32px;border:1px solid #e3e8e8">
<p style="margin:0 0 20px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#0a8f94;font-weight:700">Acqua Telecom</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${esc(title)}</h1>
${body}
</div>
<p style="font-size:12px;color:#6b7777;margin:16px 4px 0">Acqua Telecom, Zug, Switzerland · Need help? Reply to this email.</p>
</div></body></html>`;

/** The customer's eSIM: QR code inline + manual-entry details. */
export async function sendEsimEmail({ to, orderRef, item, esim }) {
  const png = await QRCode.toBuffer(esim.lpa, { type: "png", width: 360, margin: 2, errorCorrectionLevel: "M" });
  const title = `Your ${item.destName} eSIM is ready`;
  const html = shell(title, `
<p style="font-size:16px;line-height:1.5">Thanks for your order. Scan this QR code on the phone you'll travel with, then turn the new line on when you land. Your <b>${esc(item.gb)}GB</b> starts counting from the first time you connect abroad and is valid for <b>${esc(esim.days || item.days)} days</b> from then.</p>
<p style="text-align:center;margin:24px 0"><img src="cid:qr.png" width="240" height="240" alt="eSIM QR code" style="border:1px solid #e3e8e8;border-radius:12px"></p>
<h2 style="font-size:16px;margin:24px 0 8px">Can't scan? Enter it manually</h2>
<table style="font-size:14px;border-collapse:collapse;width:100%">
<tr><td style="padding:6px 0;color:#6b7777;width:150px">SM-DP+ address</td><td style="padding:6px 0;font-family:Menlo,Consolas,monospace">${esc(esim.smdpServer)}</td></tr>
<tr><td style="padding:6px 0;color:#6b7777">Activation code</td><td style="padding:6px 0;font-family:Menlo,Consolas,monospace">${esc(esim.activationCode)}</td></tr>
<tr><td style="padding:6px 0;color:#6b7777">ICCID</td><td style="padding:6px 0;font-family:Menlo,Consolas,monospace">${esc(esim.iccid)}</td></tr>
</table>
<h2 style="font-size:16px;margin:24px 0 8px">How to install</h2>
<ol style="font-size:14px;line-height:1.6;padding-left:20px;margin:0">
<li><b>iPhone:</b> Settings → Mobile/Cellular → Add eSIM → Use QR Code.</li>
<li><b>Android:</b> Settings → Network &amp; internet → SIMs → Add eSIM → scan.</li>
<li>Keep your home SIM for calls; set the new eSIM as your <b>data</b> line and turn <b>Data Roaming on</b> for it when you arrive.</li>
</ol>
<p style="font-size:13px;color:#6b7777;margin-top:24px">Order ${esc(orderRef)}. Keep this email — you can install the eSIM once, on one device.</p>`);
  return send({
    To: to,
    Subject: title,
    HtmlBody: html,
    TextBody: `${title}\n\nSM-DP+ address: ${esim.smdpServer}\nActivation code: ${esim.activationCode}\nICCID: ${esim.iccid}\nLPA: ${esim.lpa}\n\n${item.gb}GB, valid ${esim.days || item.days} days from first use. Order ${orderRef}.`,
    Tag: "esim-delivery",
    Attachments: [{ Name: "qr.png", Content: png.toString("base64"), ContentType: "image/png", ContentID: "cid:qr.png" }],
  });
}

/** Holding email when the eSIM has to be provisioned by hand. */
export async function sendPendingEmail({ to, orderRef, item }) {
  const title = item.kind === "travel" ? `Your ${item.destName} eSIM order is confirmed` : `Your UK ${item.planLabel} plan is confirmed`;
  const html = shell(title, `
<p style="font-size:16px;line-height:1.5">Thanks — payment received. Our team is preparing your ${item.kind === "travel" ? "eSIM" : "SIM"} and will email the details to this address shortly, normally within a few hours.</p>
<p style="font-size:14px;color:#6b7777">Order ${esc(orderRef)} · ${esc(item.name)}</p>`);
  return send({ To: to, Subject: title, HtmlBody: html, TextBody: `${title}\n\nOrder ${orderRef} · ${item.name}\nWe'll email your details shortly.`, Tag: "order-pending" });
}

/** Internal copy for every order, with the provisioning result or the reason it needs a human. */
export async function sendInternalEmail({ orderRef, item, customerEmail, esim, error, extra }) {
  const ok = Boolean(esim?.ok);
  const subject = `${ok ? "✅" : "⚠️ ACTION"} ${item.name} — ${customerEmail} (${orderRef})`;
  const lines = [
    `Order: ${orderRef}`, `Customer: ${customerEmail}`, `Item: ${item.name}`, `SKU: ${item.sku}`,
    `Amount: ${(item.unitAmount / 100).toFixed(2)} ${item.currency}`,
    ...(extra ? Object.entries(extra).map(([k, v]) => `${k}: ${v}`) : []),
    "",
    ok ? `Provisioned on Bridge: ICCID ${esim.iccid}, subscriber ${esim.subscriberId}, package ${esim.subsPackageId}, template ${esim.packageTemplateId}`
       : `NOT auto-provisioned: ${error || esim?.reason || "unknown"} — issue the eSIM in eSIMVault and email the customer.`,
  ];
  return send({ To: config.mail.ordersInbox, Subject: subject, TextBody: lines.join("\n"), Tag: "order-internal" });
}
