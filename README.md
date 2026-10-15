# acquatelecom.com

Marketing site plus a small shop backend for Acqua Telecom.
Hosted on Vercel (project `acqua-website`, team "Acqua Telecom Septoo"); every push to `main` deploys.
Domains: `acquatelecom.com` (redirects to www) and `www.acquatelecom.com`.

## Layout

| Path | What |
|---|---|
| `index.html` | The one-page site, including the shop UI |
| `img/` | Images |
| `data/catalog.json` | **Prices.** Travel eSIM destinations/sizes (USD, 30 days) and UK plans (GBP/month). The page and the server both read this file — edit prices here only. |
| `data/bridge-templates.json` | Maps a travel SKU (`<destination>-<gb>gb-30d`) to the eSIMVault *prepaid package template id*. Unmapped SKUs are fulfilled by hand. |
| `api/checkout.js` | `POST /api/checkout` → creates a Stripe Checkout Session (one-off for travel, monthly subscription for UK) and returns its URL |
| `api/stripe-webhook.js` | `POST /api/stripe-webhook` → on `checkout.session.completed`: issues the eSIM on Bridge, emails the QR code, emails the team. Idempotent (state kept in Stripe metadata). |
| `api/status.js` | `GET /api/status` → which integrations are configured; the page hides its "preview" notice when Stripe is live |
| `lib/` | Catalog resolver, env, Bridge OCS client, Postmark mail |
| `scripts/ocs-templates.mjs` | Lists Bridge accounts / package templates to fill `bridge-templates.json` |
| `test/` | `npm test` (set `NO_PROXY=127.0.0.1` if behind a proxy) |

## Order flow

1. Buyer picks a plan, enters email, clicks Pay → `POST /api/checkout` → redirected to Stripe Checkout (Adaptive Pricing shows local currency).
2. Stripe calls `/api/stripe-webhook`.
3. **Travel eSIM with a mapped template:** `affectPackageToSubscriber { packageTemplateId, accountForSubs }` on the OCS takes a free eSIM from the stock account and attaches the package (activation at first use, validity from the template) → customer gets an email with the QR code (inline PNG), SM-DP+ address, activation code and ICCID → team gets a ✅ copy. The PaymentIntent is tagged `fulfillment=done`, `iccid=…`.
4. **Anything else** (UK plans, physical SIM, unmapped destination, Bridge error): customer gets a "payment received, details shortly" email; team gets a ⚠️ ACTION email with everything needed to provision by hand. PaymentIntent/Subscription tagged `fulfillment=manual` with the reason.

## Go-live checklist

1. **Stripe** — in the account that should take the money: Developers → Webhooks → Add endpoint `https://www.acquatelecom.com/api/stripe-webhook`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the signing secret.
2. **Vercel env vars** (see `.env.example`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `POSTMARK_SERVER_TOKEN`, `OCS_BASE_URL`, `OCS_TOKEN`, `OCS_ACCOUNT_ID`. Redeploy after adding them.
3. **Postmark** — verify `acquatelecom.com` as a sender domain (DKIM + Return-Path records at GoDaddy) or set `MAIL_FROM` to an address on an already-verified domain.
4. **Bridge templates** — `OCS_BASE_URL=… OCS_TOKEN=… npm run ocs:templates` lists the package templates; put their ids in `data/bridge-templates.json`. Until a SKU is mapped its orders go the manual route, so the shop can go live before every destination is mapped.
5. Check `https://www.acquatelecom.com/api/status` shows `"live": true`, then do one real purchase of the cheapest plan and refund it.

Test mode works the same way with `sk_test_…` keys and a test-mode webhook endpoint (use `vercel env pull` / preview deployments).
