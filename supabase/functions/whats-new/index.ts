// One short "What's new" for an update that skipped versions (Supabase Edge
// Function). The app asks as the update starts, and again when the card shows
// if it has no answer yet:
//
//   POST {from: "1.12.0", to: "1.16.0", device: "android"}  ->  {lines: [...], source}
//
// The logic is in core.js. Here: the record (docs/release-notes.json on the
// website), the saved summaries (table whats_new_summaries, supabase/whats-new.sql)
// and the AIs, tried in order (WHATS_NEW_PROVIDERS, default
// "anthropic,openai,gemini,xai,groq"); each is used only when its key is set.
// With none set, or none answering, the app gets the plain lines.
// Bodies are text/plain JSON (no CORS preflight); no sign-in needed. Deployed
// with --no-verify-jwt; setup in supabase/WHATS-NEW.md.
import Anthropic from "npm:@anthropic-ai/sdk@1";
import { cacheKey, problemWith, whatsNew } from "./core.js";

const NOTES_URL = Deno.env.get("WHATS_NEW_NOTES_URL") ?? "https://harsh-0024.github.io/muhurta-pomodoro/release-notes.json";
const DB = `${Deno.env.get("SUPABASE_URL")}/rest/v1/whats_new_summaries`;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ORDER = (Deno.env.get("WHATS_NEW_PROVIDERS") ?? "anthropic,openai,gemini,xai,groq").split(",").map((s) => s.trim());
// Per AI; past this, the next one. Generous: the app asks while the update
// downloads, and free plans can be slow when busy. Two AIs fit within
// Supabase's 150-second limit for one request.
const TIMEOUT_MS = 60_000;
const NOTES_FRESH_MS = 5 * 60 * 1000;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// The record, re-read every few minutes so a new release is known quickly.
let notesCache: { at: number; versions: Record<string, unknown[]> } | null = null;
async function notes() {
  if (notesCache && Date.now() - notesCache.at < NOTES_FRESH_MS) return notesCache.versions;
  const res = await fetch(NOTES_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`release notes: ${res.status}`);
  const versions = (await res.json()).versions;
  notesCache = { at: Date.now(), versions };
  return versions;
}

function db(method: string, query: string, body?: unknown, prefer = "return=minimal") {
  return fetch(`${DB}?${query}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function savedLines(key: string): Promise<string[] | null> {
  try {
    const res = await db("GET", `key=eq.${encodeURIComponent(key)}&select=lines`, undefined, "");
    if (!res.ok) console.warn("saved summaries:", res.status, await res.text());
    const rows = res.ok ? await res.json() : [];
    return Array.isArray(rows[0]?.lines) ? rows[0].lines : null;
  } catch {
    return null;
  }
}

// ---- the AIs: each takes the prompt and returns its text ----

function withTimeout(signalMs: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), signalMs);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const t = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: t.signal });
    if (!res.ok) throw new Error(`${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  } finally {
    t.done();
  }
}

const env = (name: string) => (Deno.env.get(name) ?? "").trim();

function anthropic() {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) return null;
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: TIMEOUT_MS });
  const model = env("ANTHROPIC_MODEL") || "claude-opus-5-5";
  return {
    name: "anthropic",
    async ask(prompt: string) {
      const msg = await client.beta.messages.create({
        model,
        max_tokens: 2048,
        // A short rewrite: little thinking needed.
        output_config: { effort: "low" },
        // A declined request is re-run on Anthropic's recommended model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      });
      if (msg.stop_reason === "refusal") throw new Error("declined");
      return msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    },
  };
}

// ChatGPT, Grok (xAI) and Groq share the same request shape. Their model names
// change often, so each is used only when its model is named too
// (OPENAI_MODEL, XAI_MODEL, GROQ_MODEL).
// `extra` adds model-specific settings to the request.
function chatCompletions(name: string, url: string, keyVar: string, modelVar: string, extra: (model: string) => object = () => ({})) {
  const key = env(keyVar);
  const model = env(modelVar);
  if (!key || !model) return null;
  return {
    name,
    async ask(prompt: string) {
      const data = await postJson(url, { Authorization: `Bearer ${key}` }, {
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }, // the answer is always JSON
        ...extra(model),
      });
      return String(data?.choices?.[0]?.message?.content ?? "");
    },
  };
}

function gemini() {
  const key = env("GEMINI_API_KEY");
  const model = env("GEMINI_MODEL");
  if (!key || !model) return null;
  return {
    name: "gemini",
    async ask(prompt: string) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const data = await postJson(url, { "x-goog-api-key": key }, {
        contents: [{ parts: [{ text: prompt }] }],
        // A short rewrite: little thinking needed, and a quick answer.
        generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } },
      });
      return (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    },
  };
}

const MAKERS: Record<string, () => { name: string; ask(p: string): Promise<string> } | null> = {
  anthropic,
  openai: () => chatCompletions("openai", "https://api.openai.com/v1/chat/completions", "OPENAI_API_KEY", "OPENAI_MODEL"),
  gemini,
  xai: () => chatCompletions("xai", "https://api.x.ai/v1/chat/completions", "XAI_API_KEY", "XAI_MODEL"),
  // gpt-oss models think first; a short rewrite needs little, which leaves room for the answer.
  groq: () => chatCompletions("groq", "https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY", "GROQ_MODEL",
    (model) => (model.includes("gpt-oss") ? { reasoning_effort: "low" } : {})),
};

const providers = () => ORDER.map((name) => MAKERS[name]?.()).filter((p) => p !== null && p !== undefined);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  let body: { from?: string; to?: string; device?: string };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return reply(400, { error: "bad json" });
  }
  let versions: Record<string, unknown[]>;
  try {
    versions = await notes();
  } catch (err) {
    console.error(err);
    return reply(503, { error: "release notes unavailable" });
  }
  const problem = problemWith(body, versions);
  if (problem) return reply(400, { error: problem });
  const request = { from: body.from!, to: body.to!, device: body.device! };
  const key = cacheKey(request);
  const result = await whatsNew({
    notes: versions,
    ...request,
    providers: providers(),
    saved: await savedLines(key),
    save: async (lines: string[], source: string) => {
      const res = await db("POST", "on_conflict=key", { key, lines, source }, "resolution=merge-duplicates,return=minimal");
      if (!res.ok) throw new Error(`save: ${res.status} ${await res.text()}`);
    },
    warn: (who: string, why: unknown) => console.warn(who, String(why)),
  });
  if (result.fallback) console.warn("no summary for", key);
  return reply(200, result);
});
