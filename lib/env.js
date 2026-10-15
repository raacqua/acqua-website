// Central place for configuration. Every secret lives in Vercel env vars.
// Values are read on access so a changed env is picked up without a restart.
const env = (k, d) => (process.env[k] ?? d ?? "").trim();

export const config = {
  get siteUrl() { return env("SITE_URL", "https://www.acquatelecom.com"); },
  stripe: {
    get secretKey() { return env("STRIPE_SECRET_KEY"); },
    get webhookSecret() { return env("STRIPE_WEBHOOK_SECRET"); },
  },
  ocs: {
    // Bridge4IP / eSIMVault OCS. Requests are POST <baseUrl>/v1?token=<token>
    get baseUrl() { return env("OCS_BASE_URL").replace(/\/+$/, ""); },
    get token() { return env("OCS_TOKEN"); },
    // Account that holds Acqua's free travel eSIM stock (listResellerAccount → account.id)
    get accountId() { return Number(env("OCS_ACCOUNT_ID", "0")); },
  },
  mail: {
    get postmarkToken() { return env("POSTMARK_SERVER_TOKEN"); },
    // Tolerates sloppy values like "Acqua Telecom<ra@x.com" or a bare address
    get from() { return normalizeFrom(env("MAIL_FROM", "Acqua Telecom <esim@acquatelecom.com>")); },
    // Internal copy of every order (and the fallback when auto-provisioning can't run)
    get ordersInbox() { return env("ORDERS_NOTIFY", "ra@acquatelecom.com"); },
    get replyTo() { return env("MAIL_REPLY_TO", "support@acquatelecom.com"); },
  },
};

export const status = () => ({
  stripe: Boolean(config.stripe.secretKey && config.stripe.webhookSecret),
  bridge: Boolean(config.ocs.baseUrl && config.ocs.token && config.ocs.accountId),
  mail: Boolean(config.mail.postmarkToken),
});

export function normalizeFrom(v) {
  const m = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(v || "");
  if (!m) return "esim@acquatelecom.com";
  const addr = m[1];
  const name = (v.slice(0, m.index) + v.slice(m.index + addr.length)).replace(/[<>"]/g, "").trim();
  return name ? `${name} <${addr}>` : addr;
}
