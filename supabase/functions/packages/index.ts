// Packages → POS. Each package is a record (kind "package") with its tracking number; this function keeps it current.
// Tracking comes from Track123 (one key for UPS, USPS, FedEx, Amazon and the rest; the carrier is worked out from the
// number). Every 30 minutes a scheduled call refreshes everything still on its way. Shipping emails come in from the
// owner's Gmail script (same key as bank-mail) and their tracking numbers become packages on their own.
// Actions: add, refresh, set-key, status (the owner, signed in to POS), refresh (the schedule), mail (the Gmail script).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { carrierOf, trackUrl, clean, fromEmail, etaDate, readTracking, trackingsIn, pick, type Ev } from "./parse.ts";

const OWNER = "91a0d7d5-d449-4922-a08c-3c3092c608a3";
const CRON_SHA = "c997b119ab5f48e6373d65c1df95735b17d6eb083b052e3dff936b47f7a147e2";
const T123 = "https://api.track123.com/gateway/open-api/tk/v2";
const UA = "POS-packages/1.0 (personal package tracker)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- places on the map: a city and state to a point (asked once per place) ---------- */
async function geocode(db: SupabaseClient, q: string): Promise<{ lat: number; lon: number } | null> {
  const key = q.toLowerCase().trim();
  if (!key) return null;
  const { data } = await db.from("geo_cache").select("lat,lon").eq("q", key).maybeSingle();
  if (data) return Number.isFinite(data.lat) ? { lat: data.lat, lon: data.lon } : null;
  let hit: { lat: number; lon: number } | null = null;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ q, format: "jsonv2", limit: "1", countrycodes: "us" }), { headers: { "User-Agent": UA } });
    const j = r.ok ? await r.json() : [];
    if (j && j[0]) hit = { lat: +(+j[0].lat).toFixed(4), lon: +(+j[0].lon).toFixed(4) };
  } catch (_) { /* leave it unplaced this time */ }
  await db.from("geo_cache").upsert({ q: key, lat: hit ? hit.lat : null, lon: hit ? hit.lon : null });
  return hit;
}

/* ---------- the key, and talking to Track123 ---------- */
async function keyOf(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from("pos_secrets").select("data").eq("id", "track123").maybeSingle();
  return (data?.data as { key?: string })?.key || Deno.env.get("TRACK123_KEY") || null;
}
async function t123(key: string, path: string, body: unknown) {
  const r = await fetch(T123 + path, { method: "POST", headers: { "Track123-Api-Secret": key, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, j };
}

/* ---------- packages are records ---------- */
type Pkg = Record<string, unknown> & { trackNo: string };
async function readPkgs(db: SupabaseClient, uid: string): Promise<{ id: string; data: Pkg }[]> {
  const { data } = await db.from("records").select("id,data").eq("user_id", uid).eq("kind", "package");
  return (data || []) as { id: string; data: Pkg }[];
}
async function putPkg(db: SupabaseClient, uid: string, id: string, data: Pkg) {
  const { data: rows } = await db.from("records").select("id").eq("user_id", uid).eq("id", id);
  const r = rows && rows.length ? await db.from("records").update({ data }).eq("user_id", uid).eq("id", id) : await db.from("records").insert({ user_id: uid, id, kind: "package", data });
  if (r.error) throw r.error;
}
const pkgId = (n: string) => "pkg-" + n.toLowerCase();

// add one (or bring back an old one): what's known now, then registered with Track123 and asked right away
async function addPkg(db: SupabaseClient, uid: string, info: { trackNo: string; name?: string | null; store?: string | null; eta?: string | null; order?: string | null; source?: string; mailId?: string }) {
  const n = clean(info.trackNo);
  if (!/^[A-Z0-9]{8,40}$/.test(n)) throw new Error("That doesn't look like a tracking number.");
  const id = pkgId(n), carrier = carrierOf(n);
  const old = (await readPkgs(db, uid)).find((p) => p.id === id)?.data;
  const data: Pkg = {
    ...(old || { createdAt: Date.now(), stage: "label", events: [] }),
    trackNo: n, carrier: (old?.carrier as string) || carrier, url: trackUrl((old?.carrier as string) || carrier, n),
    name: info.name || old?.name || null, store: info.store || old?.store || null, order: info.order || old?.order || null,
    etaMail: info.eta || old?.etaMail || null, source: old?.source || info.source || "manual", ...(info.mailId ? { mailId: info.mailId } : {}),
  };
  await putPkg(db, uid, id, data);
  const key = await keyOf(db);
  if (key) {
    await t123(key, "/track/import", [{ trackNo: n }]).catch(() => null);
    await refresh(db, uid, [id]).catch(() => null);
  }
  return id;
}

// ask Track123 about everything still on its way (or the ones named), and write down what changed
async function refresh(db: SupabaseClient, uid: string, only?: string[]) {
  const key = await keyOf(db);
  if (!key) return { checked: 0, why: "no-key" };
  const all = await readPkgs(db, uid);
  const now = Date.now();
  const due = all.filter((p) => (only ? only.includes(p.id) : p.data.stage !== "delivered" || now - Number(p.data.deliveredAt || now) < 2 * 86400000) && !p.data.archived);
  if (!due.length) return { checked: 0 };
  const res = await t123(key, "/track/query", { trackNos: due.map((p) => p.data.trackNo) });
  if (res.status === 401 || res.status === 403) return { checked: 0, why: "bad-key" };
  await db.from("package_raw").upsert({ id: "last-query", raw: res.j, at: new Date().toISOString() });
  const found = trackingsIn(res.j);
  let changed = 0;
  for (const p of due) {
    const t = found.find((x) => clean(String(x.trackNo ?? x.trackingNumber ?? x.trackNumber)) === p.data.trackNo);
    const d: Pkg = { ...p.data, checkedAt: now };
    if (!t) {
      // not known to Track123 yet: register it again (it was added before the key, or the import didn't take)
      await t123(key, "/track/import", [{ trackNo: p.data.trackNo }]).catch(() => null);
    } else {
      const r = readTracking(t);
      const carrier = String(pick(t, /courierName|carrierName/i) ?? "") || (p.data.carrier as string);
      Object.assign(d, { stage: r.stage, status: r.status || null, sub: r.sub || null, etaCarrier: r.eta || p.data.etaCarrier || null, carrier, url: trackUrl(carrier, p.data.trackNo) });
      if (r.events.length) d.events = r.events;
      if (r.stage === "delivered" && !p.data.deliveredAt) d.deliveredAt = r.latest ? r.latest.at : now;
      // where it is now: the newest event that names a place; where it started: the oldest one
      const placed = r.events.filter((e) => e.state || e.city);
      const at = placed[0], from = placed[placed.length - 1];
      const spot = async (e?: Ev) => {
        if (!e) return null;
        const q = [e.city, e.state].filter(Boolean).join(", ");
        const g = q ? await geocode(db, q) : null;
        return { city: e.city || null, state: e.state || null, label: e.place || q, ...(g || {}) };
      };
      if (at) d.where = await spot(at);
      if (from && (!p.data.from || (p.data.from as { label?: string }).label !== from.place)) d.from = await spot(from);
    }
    if (JSON.stringify(d) !== JSON.stringify({ ...p.data, checkedAt: now })) changed++;
    await putPkg(db, uid, p.id, d);
  }
  return { checked: due.length, changed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  // the schedule: refresh everything
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    if ((await sha256(cron)) !== CRON_SHA) return json({ error: "not allowed" }, 403);
    return json(await refresh(db, OWNER));
  }

  // the Gmail script: shipping emails
  const mailKey = req.headers.get("x-pos-key");
  if (mailKey) {
    const { data: who } = await db.from("bank_mail_keys").select("user_id").eq("key_hash", await sha256(mailKey)).maybeSingle();
    if (!who) return json({ error: "Unknown key" }, 401);
    const uid = who.user_id as string;
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(0, 30);
    const have = new Set((await readPkgs(db, uid)).map((p) => p.data.trackNo));
    const added: string[] = [];
    for (const m of msgs) {
      const e = fromEmail(String(m.subject || ""), String(m.body || ""));
      const store = String(m.from || "").replace(/<.*>/, "").replace(/"/g, "").trim().slice(0, 60) || null;
      for (const x of e.numbers.slice(0, 5)) {
        if (have.has(x.n)) continue;
        await addPkg(db, uid, { trackNo: x.n, name: e.item, store, eta: etaDate(e.eta, Number(m.date) || Date.now()), order: e.order, source: "email", mailId: String(m.id || "") }).catch(() => null);
        have.add(x.n); added.push(x.n);
      }
    }
    return json({ ok: true, added });
  }

  // everything else: the owner, signed in to POS
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  if (who?.user?.id !== OWNER) return json({ error: "sign in to POS first" }, 401);

  try {
    if (action === "add") {
      const id = await addPkg(db, OWNER, { trackNo: String(body.trackNo || ""), name: body.name ? String(body.name).slice(0, 80) : null, store: body.store ? String(body.store).slice(0, 60) : null, eta: body.eta || null });
      return json({ ok: true, id });
    }
    if (action === "refresh") return json(await refresh(db, OWNER, Array.isArray(body.ids) ? body.ids.map(String) : undefined));
    if (action === "status") return json({ key: !!(await keyOf(db)) });
    if (action === "set-key") {
      const key = String(body.key || "").trim();
      if (key.length < 10) return json({ error: "That key looks too short." }, 400);
      const test = await t123(key, "/track/query", { trackNos: ["1Z0000000000000000"] });
      await db.from("package_raw").upsert({ id: "key-test", raw: { status: test.status, j: test.j }, at: new Date().toISOString() });
      const msg = String((test.j as { msg?: string; message?: string } | null)?.msg ?? (test.j as { message?: string } | null)?.message ?? "");
      if (test.status === 401 || test.status === 403 || /unauthori|invalid.*(key|secret)|(key|secret).*(invalid|wrong|error)|forbidden/i.test(msg)) return json({ error: "Track123 didn't accept that key." }, 400);
      await db.from("pos_secrets").upsert({ id: "track123", data: { key }, updated_at: new Date().toISOString() });
      // register what's already here, then look everything up
      const pk = await readPkgs(db, OWNER);
      if (pk.length) await t123(key, "/track/import", pk.map((p) => ({ trackNo: p.data.trackNo }))).catch(() => null);
      return json({ ok: true, ...(await refresh(db, OWNER)) });
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message || e).slice(0, 200) }, 400);
  }
  return json({ error: "unknown action" }, 400);
});
