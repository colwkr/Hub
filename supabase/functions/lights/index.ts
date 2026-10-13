// Oasis lights → POS. The lights live in the Oasis cloud (an ESP RainMaker service); this function talks to it for POS.
// It keeps only the Oasis key in oasis_auth (an access key that lasts a day, and the refresh key that gets new ones),
// never a login or password. Only the owner's signed-in POS can read or change the lights.
// Actions: "state" (every light: on, brightness, white), "set" (change some lights), "connect" (the owner's signed-in POS
// hands over the keys Oasis gave it after the owner signed in to Oasis in the browser; the email and password went only to
// Oasis and never come here), "store-key" (the owner's machine hands over a new key; it proves itself with a nonce whose
// SHA-256 is below).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const API = "https://0sb7eb48mj.execute-api.us-east-1.amazonaws.com/dev/v1";
const COGNITO = "https://cognito-idp.us-east-1.amazonaws.com/";
const CLIENT_ID = "20hc2tbnm5cqipo83tq7fr6lt1";
const OWNER = "91a0d7d5-d449-4922-a08c-3c3092c608a3";
const NONCE_SHA = "ff131ff3ea167d4fb8573ebd89fcc152c65f31c9eaadd2ecb71667a32fcb12c7";
// the only settings POS may change on a light
const PARAMS = new Set(["Power", "Brightness", "CCT", "Color", "Light Mode"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pos-nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// when a key runs out (seconds since 1970), read from inside the key
function claims(jwt?: string): Record<string, unknown> {
  try {
    const p = jwt!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4))) || {};
  } catch (_) {
    return {};
  }
}
const expOf = (jwt?: string): number => Number(claims(jwt).exp) || 0;

type Auth = { access?: string; refresh?: string; refreshed_at?: number; stored_at?: number };
async function readAuth(db: SupabaseClient): Promise<Auth> {
  const { data } = await db.from("oasis_auth").select("data").eq("id", "main").maybeSingle();
  return (data?.data as Auth) || {};
}
async function writeAuth(db: SupabaseClient, d: Auth) {
  const { error } = await db.from("oasis_auth").upsert({ id: "main", data: d, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// a working access key: the kept one while it has a few minutes left, else a new one from the refresh key
async function accessKey(db: SupabaseClient, force = false): Promise<{ tok?: string; auth: Auth; why?: string }> {
  const auth = await readAuth(db);
  if (!force && auth.access && expOf(auth.access) - Date.now() / 1000 > 120) return { tok: auth.access, auth };
  const refresh = auth.refresh || Deno.env.get("OASIS_REFRESH");
  if (!refresh) return { auth, why: "no-refresh" };
  let tok = "", nextRefresh = "", why = "";
  // 1) straight to the Oasis sign-in service (Cognito) with the refresh key
  const r = await fetch(COGNITO, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
    body: JSON.stringify({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: CLIENT_ID, AuthParameters: { REFRESH_TOKEN: refresh } }),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (j?.AuthenticationResult?.AccessToken) {
    tok = j.AuthenticationResult.AccessToken;
    nextRefresh = j.AuthenticationResult.RefreshToken || "";
  } else {
    why = String(j?.__type || r?.status || "no answer");
    // 2) the Oasis cloud's own renew (the same thing their app does), with the account id read from the old key
    const who = String(claims(auth.access).username || claims(auth.access)["cognito:username"] || "");
    const tries = [...(who ? [{ user_name: who, refreshtoken: refresh }] : []), { refreshtoken: refresh }];
    for (const path of ["/login2", "/login"]) {
      for (const b of tries) {
        const r2 = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).catch(() => null);
        const j2 = r2 ? await r2.json().catch(() => ({})) : {};
        if (j2?.accesstoken) { tok = j2.accesstoken; nextRefresh = j2.refreshtoken || ""; break; }
        why += ` / ${path}: ${j2?.error_code || r2?.status || "no answer"}`;
      }
      if (tok) break;
    }
  }
  if (!tok) return { auth, why };
  const next: Auth = { ...auth, access: tok, refreshed_at: Date.now() };
  if (nextRefresh) next.refresh = nextRefresh;
  await writeAuth(db, next);
  return { tok: next.access, auth: next };
}

// one call to the Oasis cloud; a refused key gets one fresh try
async function oasis(db: SupabaseClient, path: string, init: RequestInit = {}) {
  let k = await accessKey(db);
  if (!k.tok) return { expired: true, why: k.why };
  const go = (tok: string) =>
    fetch(API + path, { ...init, headers: { ...(init.headers || {}), Authorization: tok, "Content-Type": "application/json" } });
  let r = await go(k.tok);
  if (r.status === 401 || r.status === 403) {
    k = await accessKey(db, true);
    if (!k.tok) return { expired: true, why: k.why };
    r = await go(k.tok);
    if (r.status === 401 || r.status === 403) return { expired: true, why: String(r.status) };
  }
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body, until: expOf(k.tok) * 1000, refresh: !!(k.auth.refresh || Deno.env.get("OASIS_REFRESH")) };
}

const NODE = /^[A-Za-z0-9]{8,40}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  // the owner's machine hands over a new Oasis key
  if (action === "store-key") {
    const nonce = req.headers.get("x-pos-nonce") || "";
    if (!nonce || (await sha256(nonce)) !== NONCE_SHA) return json({ error: "not allowed" }, 403);
    const auth = await readAuth(db);
    const next: Auth = { ...auth, stored_at: Date.now() };
    if (typeof body.access === "string" && expOf(body.access) > 0) next.access = body.access.trim();
    if (typeof body.refresh === "string" && body.refresh.length > 20) next.refresh = body.refresh.trim();
    if (!next.access && !next.refresh) return json({ error: "no key in that" }, 400);
    await writeAuth(db, next);
    return json({ ok: true, until: expOf(next.access) * 1000, refresh: !!next.refresh });
  }

  // everything else: only the owner, signed in to POS
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  if (who?.user?.id !== OWNER) return json({ error: "sign in to POS first" }, 401);

  // the owner signed in to Oasis from POS in the browser; only the keys Oasis handed back arrive here
  if (action === "connect") {
    const access = typeof body.access === "string" ? body.access.trim() : "";
    const refresh = typeof body.refresh === "string" ? body.refresh.trim() : "";
    if (expOf(access) * 1000 < Date.now() || refresh.length < 20) return json({ error: "Those aren't working Oasis keys." });
    const auth = await readAuth(db);
    await writeAuth(db, { ...auth, access, refresh, stored_at: Date.now(), refreshed_at: Date.now() });
    // renew once now, so a refresh key that can't renew shows up today instead of tomorrow
    const renew = await accessKey(db, true);
    const r = await oasis(db, "/user/nodes?node_details=true&status=true&params=true");
    if ("expired" in r) return json({ error: "Oasis didn't accept the new key.", why: r.why });
    return json({ ok: r.ok, lights: (r.body?.node_details || []).length, until: r.until, renews: !!renew.tok, why: renew.why || "" });
  }

  if (action === "state") {
    const r = await oasis(db, "/user/nodes?node_details=true&status=true&params=true");
    if ("expired" in r) return json({ expired: true, why: r.why });
    if (!r.ok) return json({ error: `Oasis answered ${r.status}` }, 502);
    const nodes = ((r.body?.node_details || []) as any[]).map((n) => {
      const L = n?.params?.Light || {};
      return {
        id: n.id,
        name: L.Name || "",
        online: !!n?.status?.connectivity?.connected,
        on: !!L.Power,
        level: Number.isFinite(L.Brightness) ? L.Brightness : null,
        kelvin: Number.isFinite(L.CCT) ? L.CCT : null,
        mode: L["Light Mode"] ?? null,
      };
    });
    return json({ nodes, until: r.until, refresh: r.refresh });
  }

  if (action === "set") {
    const items = (Array.isArray(body.items) ? body.items : [])
      .filter((x: any) => x && NODE.test(String(x.id)) && x.params && typeof x.params === "object")
      .map((x: any) => ({
        node_id: String(x.id),
        payload: { Light: Object.fromEntries(Object.entries(x.params).filter(([k, v]) => PARAMS.has(k) && v !== undefined && v !== null)) },
      }))
      .filter((x: any) => Object.keys(x.payload.Light).length)
      .slice(0, 50);
    if (!items.length) return json({ error: "nothing to change" }, 400);
    const r = await oasis(db, "/user/nodes/params", { method: "PUT", body: JSON.stringify(items) });
    if ("expired" in r) return json({ expired: true, why: r.why });
    if (!r.ok) return json({ error: `Oasis answered ${r.status}`, detail: r.body }, 502);
    const done = (Array.isArray(r.body) ? r.body : []).map((x: any) => ({ id: x.node_id, ok: x.status === "success" }));
    return json({ done, until: r.until, refresh: r.refresh });
  }

  return json({ error: "unknown action" }, 400);
});
