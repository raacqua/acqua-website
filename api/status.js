// GET /api/status → which integrations are configured. The page uses `live`
// to hide the "preview" notice once Stripe is connected. No secrets exposed.
import { status } from "../lib/env.js";

export default function handler(req, res) {
  const s = status();
  res.setHeader("Cache-Control", "public, max-age=60");
  res.status(200).json({ live: s.stripe, stripe: s.stripe, bridge: s.bridge, mail: s.mail });
}
