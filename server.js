import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const MRF_BASE_URL = "https://mrfsms.com/api/v1";

// Heroku allows up to 30s per request on a paid dyno. We leave a safety
// margin so OUR OWN timeout always fires first — that way we always
// return a clean, useful response instead of the platform just cutting
// the connection mid-flight.
const MRF_TIMEOUT_MS = 25000;

function adminClient() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
  // We only ever use this client for auth checks and plain database
  // queries — never Supabase's Realtime (websocket) features. Disabling
  // it outright avoids the client trying to set up a websocket connection
  // at all, sidestepping any Node-version/WebSocket-support issues.
  return createClient(url, key, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 0 } },
  });
}

async function requireUser(req, client) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await client.from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile || profile.status === "blocked") return null;
  return profile;
}

// Real timeout (fetch()'s own `timeout` option is silently ignored) —
// same fix already applied on the Vercel side after discovering it there.
async function mrfCall(apiKey, method, endpoint, params = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MRF_TIMEOUT_MS);
  try {
    let url = MRF_BASE_URL + endpoint;
    const opt = {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (method === "GET" && Object.keys(params).length) {
      url += `?${new URLSearchParams(params).toString()}`;
    } else if (method !== "GET") {
      opt.body = JSON.stringify(params);
    }
    const res = await fetch(url, opt);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") return { error: "MRF SMS did not respond in time.", timedOut: true };
    return { error: e.message || "Could not reach MRF SMS." };
  } finally {
    clearTimeout(timeoutId);
  }
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "mrf-relay-service" });
});

/**
 * POST /buy-server4-number
 * Headers: Authorization: Bearer <supabase access token>  (same one the
 *   frontend already sends to the Vercel API — see src/lib/api.ts)
 * Body: { service, countryId, tierNumber?, quantity? }
 *
 * Does the FULL Server 4 purchase flow itself — wallet hold, calling MRF
 * with a generous timeout, and recording the result — instead of relaying
 * through Vercel, which would still be capped at ~10 seconds no matter how
 * long Heroku itself is willing to wait. This is why the frontend calls
 * this URL directly for Server 4 purchases instead of going through the
 * normal Vercel API for this one step.
 */
app.post("/buy-server4-number", async (req, res) => {
  try {
    const client = adminClient();

    const profile = await requireUser(req, client);
    if (!profile) return res.status(401).json({ error: "Authentication required." });

    const { service, countryId, tierNumber, quantity } = req.body || {};
    if (!service || !countryId) return res.status(400).json({ error: "service and countryId are required." });
    const qty = Math.min(5, Math.max(1, Number(quantity) || 1));

    const { data: settings, error: settingsErr } = await client
      .from("server4_settings")
      .select("api_key, profit_margin_percent")
      .limit(1)
      .maybeSingle();
    if (settingsErr) return res.status(500).json({ error: `Settings lookup failed: ${settingsErr.message}` });
    const apiKey = settings?.api_key || "";
    if (!apiKey) return res.status(500).json({ error: "MRF SMS API key not configured." });
    const margin = Number(settings?.profit_margin_percent || 50);

    const { data: countryData, error: countryErr } = await client
      .from("server4_countries")
      .select("*, server4_price_overrides(override_price)")
      .eq("service_type", service)
      .eq("country_id", Number(countryId))
      .eq("active", true)
      .maybeSingle();
    if (countryErr) return res.status(500).json({ error: `Country lookup failed: ${countryErr.message}` });
    if (!countryData) return res.status(502).json({ error: "No numbers available on Server 4 for this country." });

    let unitPrice, tierBasePrice;
    if (tierNumber) {
      const tier = (countryData.tiers || []).find((t) => Number(t.tierNumber) === Number(tierNumber));
      if (!tier) return res.status(404).json({ error: "That tier is no longer available — refresh and pick again." });
      tierBasePrice = Number(tier.price);
    } else {
      const overridePrice = countryData.server4_price_overrides?.[0]?.override_price;
      tierBasePrice = overridePrice != null ? Number(overridePrice) : Number(countryData.base_price);
    }
    unitPrice = Math.ceil(tierBasePrice * (1 + margin / 100));

    const results = [];
    const failures = [];

    for (let i = 0; i < qty; i++) {
      const { data: freshProfile, error: profileErr } = await client
        .from("profiles")
        .select("wallet_balance, referral_balance, wallet_hold")
        .eq("id", profile.id)
        .single();
      if (profileErr) {
        failures.push(`Balance check failed: ${profileErr.message}`);
        break;
      }
      const available = Number(freshProfile.wallet_balance) + Number(freshProfile.referral_balance || 0) - Number(freshProfile.wallet_hold);
      if (available < unitPrice) {
        failures.push("Insufficient balance.");
        break;
      }

      const { error: ensureErr } = await client.rpc("ensure_wallet_funds_from_referral", { p_user_id: profile.id, p_needed: unitPrice });
      if (ensureErr) {
        failures.push(`Wallet setup failed: ${ensureErr.message}`);
        break;
      }
      const { data: held, error: holdErr } = await client.rpc("hold_wallet", { p_user_id: profile.id, p_amount: unitPrice });
      if (holdErr) {
        failures.push(`Wallet hold failed: ${holdErr.message}`);
        break;
      }
      if (!held) {
        failures.push("Insufficient available balance.");
        break;
      }

      // The whole point of running this on Heroku: we can just wait for
      // MRF's real answer (up to MRF_TIMEOUT_MS) in one shot, no need for
      // Vercel's "create a placeholder and reconcile later via polling"
      // workaround that a 10-second platform limit forced us into there.
      const mrfResp = tierNumber
        ? await mrfCall(apiKey, "POST", "/orders", { service, countryId: Number(countryId), tierNumber: Number(tierNumber) })
        : await mrfCall(apiKey, "POST", "/orders", { service, countryId: Number(countryId) });

      if (mrfResp.error || !mrfResp.phoneNumber) {
        await client.rpc("release_hold", { p_user_id: profile.id, p_amount: unitPrice });
        failures.push(
          mrfResp.timedOut
            ? "MRF SMS did not respond in time — nothing was charged. Please try again."
            : tierNumber
            ? `Tier ${tierNumber} just sold out (shared stock ran out) — please pick a different tier or refresh and try again.`
            : mrfResp.error || "No numbers available on Server 4 right now."
        );
        break;
      }

      const number = mrfResp.phoneNumber;
      const displayCountry = mrfResp.country || countryData.country_name || "Unknown";
      const expires = new Date(Date.now() + 15 * 60000).toISOString(); // 15-minute OTP hold, same as Vercel side

      const { data: row, error: insertErr } = await client
        .from("number_requests")
        .insert({
          user_id: profile.id,
          service,
          country: displayCountry,
          number,
          operator: "Mobile",
          server: 4,
          cost: unitPrice,
          hold_amount: unitPrice,
          expires_at: expires,
          status: "pending",
        })
        .select("id, number, service, country, status, expires_at, server")
        .single();
      if (insertErr) {
        failures.push(`Could not save the purchase: ${insertErr.message}`);
        break;
      }

      const { error: ordersInsertErr } = await client.from("server4_orders").insert({
        user_id: profile.id,
        mrf_order_id: mrfResp.orderId,
        service_type: service,
        country_name: displayCountry,
        country_id: Number(countryId),
        phone_number: number,
        base_price: tierBasePrice,
        profit_margin: margin,
        user_price: unitPrice,
        tier_number: tierNumber || null,
        status: mrfResp.status || "pending",
        expires_at: mrfResp.expiresAt || null,
        request_id: row?.id || null,
      });
      if (ordersInsertErr) {
        // The number_requests row (what the customer sees) is already
        // saved — this second table is just our own bookkeeping, so log
        // it but don't fail the whole purchase over it.
        console.error("server4_orders insert failed:", ordersInsertErr.message);
      }

      results.push(row);
    }

    if (!results.length) return res.status(402).json({ error: failures[0] || "Could not complete purchase." });
    return res.json({ success: true, request: results[0], requests: results, failures });
  } catch (e) {
    console.error("buy-server4-number crashed:", e);
    return res.status(500).json({ error: e.message || "Unexpected server error." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`mrf-relay-service listening on port ${port}`);
});
