// POS assistant: what you say to POS, understood by Claude. The key lives here, in pos_secrets ("anthropic"), and never
// reaches the browser. The browser sends what you said plus a small summary (today's tasks, upcoming meetings, a few
// counts), never the whole database. Claude answers through one tool: a short reply to speak, and at most one action.
// POS asks before it changes anything. Build changes (new features, a different look) are never attempted here; the
// reply says it's a job for Claude and offers to save the idea as a note.
// Actions (the owner, signed in to POS): status, set-key, clear-key, ask.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const OWNER = "91a0d7d5-d449-4922-a08c-3c3092c608a3";
const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const PREFER = ["claude-haiku-5-5", "claude-sonnet-5-5"]; // cheapest first; set-key also checks what the key can use
const DAY_CAP = 300; // asks a day, a ceiling well under the included credits

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Secret = { key: string; setAt: number; days: number | null; model: string };
async function secret(db: SupabaseClient): Promise<Secret | null> {
  const { data } = await db.from("pos_secrets").select("data").eq("id", "anthropic").maybeSingle();
  const s = data?.data as Secret | undefined;
  return s && s.key ? s : null;
}
const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function usage(db: SupabaseClient) {
  const { data } = await db.from("pos_secrets").select("data").eq("id", "anthropic-usage").maybeSingle();
  const u = (data?.data || {}) as { day?: string; n?: number; month?: string; m?: number; inTok?: number; outTok?: number };
  const day = nyDay(), month = day.slice(0, 7);
  return { day, month, n: u.day === day ? u.n || 0 : 0, m: u.month === month ? u.m || 0 : 0, inTok: u.month === month ? u.inTok || 0 : 0, outTok: u.month === month ? u.outTok || 0 : 0 };
}

const SECTIONS = ["home", "tasks", "calendar", "notes", "reminders", "work", "projects", "meetings", "audio", "video", "lighting", "finance", "health", "car", "places", "packages", "pets", "lights", "tv", "camplot", "settings"];
const ACTIONS = ["none", "open", "add_task", "complete_task", "move_task", "add_reminder", "add_note", "camera", "build_note"];
const TOOL = {
  name: "respond",
  description: "Answer the owner and, if he asked for something to be done, pick one action for POS to take.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "What to say back. It is spoken aloud: one or two short sentences, plain words, no lists, no markdown, no emoji." },
      action: { type: "string", enum: ACTIONS },
      section: { type: "string", enum: SECTIONS, description: "For open." },
      id: { type: "string", description: "For complete_task and move_task: a task id copied exactly from the summary." },
      title: { type: "string", description: "For add_task, add_reminder, add_note and build_note." },
      details: { type: "string", description: "For add_note and build_note: the body. For add_reminder: optional details." },
      date: { type: "string", description: "YYYY-MM-DD, or empty for no day. For add_task, move_task and add_reminder." },
      time: { type: "string", description: "HH:MM, 24-hour, or empty. For add_task and move_task." },
      mins: { type: "integer", description: "For add_task: how many minutes it takes, only if he said." },
      tag: { type: "string", enum: ["work", "personal", ""], description: "For add_task: work or personal, if it's clear." },
      camera: { type: "integer", description: "For camera: which camera, 1 to 6." },
    },
    required: ["reply", "action"],
  },
};
function system(name: string, ctx: Record<string, unknown>) {
  return `You are ${name || "POS"}, the assistant built into POS, the owner's personal operating system: tasks, calendar, notes, reminders, work (he runs broadcast production at Upstate Church: cameras, audio, video, lighting, CG), finance, health, car, places, packages, pets, home lights and a TV remote.
Today is ${ctx.today} (${ctx.weekday}); it is ${ctx.now} in America/New_York.
Below is a short summary of his data. Use only what it says. Never invent tasks, ids, amounts or facts. If the answer isn't in it, say so briefly and offer to open the section that has it.
Always answer with the respond tool, with one action at most:
- none: just answer (what's today, what's next, how many, when).
- open: show a section. camplot is the 3D camera plot.
- add_task, complete_task, move_task: tasks. Copy ids exactly from the summary. Turn "tomorrow", "Friday", "next week" into dates from today.
- add_reminder: something to keep in mind that isn't a task, maybe on a day.
- add_note: save a note.
- camera: open one camera's operate view in the camera plot.
- build_note: if he asks for something POS can't do yet (a new feature, a new section, changing how it looks or works), don't pretend you can. Say that's a build change for Claude and offer to save it as a note; put the idea in title and details.
POS shows any change and asks him before doing it, so word those replies as the thing you're about to do ("Add call the bank for Friday?").
If you didn't catch what he meant, ask one short question with action none.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  if (who?.user?.id !== OWNER) return json({ error: "sign in to POS first" }, 401);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  try {
    if (action === "status") {
      const s = await secret(db), u = await usage(db);
      return json({ key: !!s, setAt: s?.setAt || null, days: s?.days ?? null, model: s?.model || null, today: u.n, month: u.m, cap: DAY_CAP });
    }
    if (action === "clear-key") {
      await db.from("pos_secrets").delete().eq("id", "anthropic");
      return json({ ok: true });
    }
    if (action === "set-key") {
      const key = String(body.key || "").trim();
      if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) return json({ error: "That doesn't look like a Claude API key. It starts with sk-ant-." }, 400);
      // a free check: list the models this key can use
      const r = await fetch(API + "/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": VERSION } });
      if (r.status === 401 || r.status === 403) return json({ error: "Claude didn't accept that key." }, 400);
      const j = await r.json().catch(() => null) as { data?: { id: string }[] } | null;
      const ids = (j?.data || []).map((m) => m.id);
      const model = PREFER.find((m) => ids.includes(m)) || ids.find((m) => /haiku/.test(m)) || ids.find((m) => /sonnet/.test(m)) || PREFER[0];
      const days = body.days === null || body.days === "never" ? null : Math.max(1, Math.min(400, Number(body.days) || 30));
      await db.from("pos_secrets").upsert({ id: "anthropic", data: { key, setAt: Date.now(), days, model }, updated_at: new Date().toISOString() });
      return json({ ok: true, model, days });
    }
    if (action === "ask") {
      const s = await secret(db);
      if (!s) return json({ error: "no-key" }, 200);
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) return json({ error: "empty" }, 400);
      const u = await usage(db);
      if (u.n >= DAY_CAP) return json({ error: "cap" }, 200);
      const ctx = (body.ctx && typeof body.ctx === "object" ? body.ctx : {}) as Record<string, unknown>;
      const summary = JSON.stringify(ctx).slice(0, 7000); // a ceiling on what goes out, whatever the browser sends
      const r = await fetch(API + "/messages", {
        method: "POST",
        headers: { "x-api-key": s.key, "anthropic-version": VERSION, "content-type": "application/json" },
        body: JSON.stringify({
          model: s.model || PREFER[0], max_tokens: 400, temperature: 0.2,
          system: system(String(body.name || ""), ctx),
          tools: [TOOL], tool_choice: { type: "tool", name: "respond" },
          messages: [{ role: "user", content: `Summary of his data:\n${summary}\n\nHe said: "${text}"` }],
        }),
      });
      const j = await r.json().catch(() => null) as Record<string, any> | null;
      if (!r.ok) {
        const msg = String(j?.error?.message || "");
        if (r.status === 401 || r.status === 403) return json({ error: "key" });
        if (/credit balance|billing|spend limit|usage limit/i.test(msg)) return json({ error: "credits" });
        if (r.status === 429 || r.status === 529) return json({ error: "busy" });
        return json({ error: "failed", detail: msg.slice(0, 160) });
      }
      const use = j?.usage || {};
      await db.from("pos_secrets").upsert({ id: "anthropic-usage", data: { day: u.day, n: u.n + 1, month: u.month, m: u.m + 1, inTok: u.inTok + (use.input_tokens || 0), outTok: u.outTok + (use.output_tokens || 0) }, updated_at: new Date().toISOString() });
      const call = (j?.content || []).find((c: { type: string }) => c.type === "tool_use");
      const out = (call?.input || {}) as Record<string, unknown>;
      if (!ACTIONS.includes(String(out.action))) out.action = "none";
      return json({ ok: true, reply: String(out.reply || "").slice(0, 400), act: out });
    }
  } catch (e) {
    return json({ error: "failed", detail: String((e as Error)?.message || e).slice(0, 160) }, 200);
  }
  return json({ error: "unknown action" }, 400);
});
