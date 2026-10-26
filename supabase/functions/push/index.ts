// Notifications for the iPhone app when it is closed (Supabase Edge Function).
//
// iOS stops a web app the moment it leaves the screen, so the app cannot ring
// at the end of a block itself. Instead, as it leaves the screen it books the
// end time here (mobile/web/web-alerts.js); when that time comes, this sends a
// Web Push through Apple, which shows the notification even with the phone
// locked. Coming back to the app cancels the booking: the timer rings itself.
//
//   GET                               -> { publicKey }  (for subscribing)
//   POST {action:"book", subscription, at, title, body}
//   POST {action:"cancel", endpoint}
//   POST {action:"send"}              -> sends what is due (pg_cron, supabase/push.sql)
//
// Bodies are text/plain JSON so the phone can send them with sendBeacon as it
// leaves the screen (no CORS preflight, no sign-in needed). The subscription
// itself is the key: whoever books can only notify that one subscription.
// Deployed with --no-verify-jwt; setup in supabase/PUSH.md.
import { importVapid, sendPush } from "./webpush.js";

const DB = `${Deno.env.get("SUPABASE_URL")}/rest/v1/push_bookings`;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:muhurata.pomodoro.timer@gmail.com";
const vapid = importVapid(Deno.env.get("VAPID_PUBLIC_KEY") ?? "", Deno.env.get("VAPID_PRIVATE_KEY") ?? "");

// Only real push services: Apple's, and the browsers' own (Chrome, Firefox, Edge).
const PUSH_HOST = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_AHEAD_MS = 26 * 60 * 60 * 1000;
// Bookings that went unsent this long (the schedule was off) are dropped.
const STALE_MS = 5 * 60 * 1000;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function db(method: string, query: string, body?: unknown, prefer = "return=minimal") {
  return fetch(`${DB}?${query}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const text = (v: unknown, max: number) => String(v ?? "").slice(0, max);

function cleanSubscription(raw: any) {
  const endpoint = String(raw?.endpoint ?? "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const p256dh = String(raw?.keys?.p256dh ?? "");
  const auth = String(raw?.keys?.auth ?? "");
  if (url.protocol !== "https:" || !PUSH_HOST.test(url.hostname) || endpoint.length > 1000) return null;
  if (!B64URL.test(p256dh) || p256dh.length > 100 || !B64URL.test(auth) || auth.length > 40) return null;
  return { endpoint, p256dh, auth };
}

async function book(body: any) {
  const sub = cleanSubscription(body.subscription);
  const at = Number(body.at);
  if (!sub) return reply(400, { error: "bad subscription" });
  if (!Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + MAX_AHEAD_MS) return reply(400, { error: "bad time" });
  // One booking per phone: a new one replaces the last.
  const row = { ...sub, fire_at: new Date(at).toISOString(), title: text(body.title, 100), body: text(body.body, 300) };
  const res = await db("POST", "on_conflict=endpoint", row, "resolution=merge-duplicates,return=minimal");
  return res.ok ? reply(200, { booked: row.fire_at }) : reply(502, { error: "could not book" });
}

async function cancel(body: any) {
  const endpoint = String(body.endpoint ?? "");
  if (!endpoint || endpoint.length > 1000) return reply(400, { error: "bad endpoint" });
  const res = await db("DELETE", `endpoint=eq.${encodeURIComponent(endpoint)}`);
  return res.ok ? reply(200, { cancelled: true }) : reply(502, { error: "could not cancel" });
}

// Everything due, taken off the table in one step (so two runs never send
// the same one twice), then sent.
async function sendDue() {
  const res = await db("DELETE", `fire_at=lte.${encodeURIComponent(new Date().toISOString())}`, undefined, "return=representation");
  if (!res.ok) return reply(502, { error: "could not read bookings" });
  const due = (await res.json()).filter((row: any) => Date.parse(row.fire_at) > Date.now() - STALE_MS);
  const key = await vapid;
  const results = await Promise.allSettled(due.map((row: any) =>
    // A notification that arrives minutes late is worse than none: Apple
    // drops it if it cannot deliver within two minutes.
    sendPush(key, SUBJECT, row, { title: row.title, body: row.body, tag: "muhurta-block-end" }, 120)
  ));
  const sent = results.filter((r) => r.status === "fulfilled" && r.value < 300).length;
  for (const r of results) if (r.status === "rejected" || r.value >= 300) console.warn("push failed", r.status === "fulfilled" ? r.value : r.reason);
  return reply(200, { due: due.length, sent });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") return reply(200, { publicKey: (await vapid).publicKey });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  let body: any;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return reply(400, { error: "bad json" });
  }
  try {
    if (body?.action === "book") return await book(body);
    if (body?.action === "cancel") return await cancel(body);
    if (body?.action === "send") return await sendDue();
  } catch (err) {
    console.error(err);
    return reply(500, { error: "failed" });
  }
  return reply(400, { error: "unknown action" });
});
