// Regions alert emails → POS.
// A small Google Apps Script in the owner's Gmail sends each new email from alert.regions.com here, about once a minute.
// Every email is kept in bank_mail as it arrived. Charges and deposits become Finance transactions (they show up in
// "Needs approval", and bills they match get checked off in the app); balance alerts reset that account's balance.
// The script proves who it sends for with a key; only the key's SHA-256 is stored (bank_mail_keys).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Parsed = { type: "out" | "in" | "balance" | "skip" | null; amount?: number; last4?: string; merchant?: string; why?: string };
const MONEY = String.raw`\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)`;
const cents = (s: string) => Math.round(parseFloat(s.replace(/,/g, "")) * 100);
// security and settings notices, not money
const NOTICE = /verify|log ?in|new device|preference|password|one-time|security code|passcode|profile|paperless|statement is (?:ready|available)|enroll/i;

export function parse(subject: string, body: string): Parsed {
  const s = (subject || "").trim();
  if (NOTICE.test(s)) return { type: "skip", why: "account notice" };
  // the alert's own words, without the legal footer, link stubs and table bars
  let text = (body || "").split(/Service Email:|Privacy and Security:|Contacting Us:/)[0];
  text = text.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/\|/g, " ").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const all = `${s}\n${text}`;
  const low = all.toLowerCase();

  let type: Parsed["type"] = null;
  if (/balance/i.test(s) && !/withdraw|deposit|purchase|transaction|payment/i.test(s)) type = "balance";
  else if (/deposit|credit(?!\s*card)|incoming|refund|transfer in/i.test(s)) type = "in";
  else if (/withdraw|purchase|debit|card|transaction|payment|spent|charge|ach|check/i.test(s)) type = "out";
  else if (/\b(?:deposit|was credited|has been credited|credit of)\b/.test(low)) type = "in";
  else if (/\b(?:withdrawal|purchase|was debited|has been debited|was used|debit of|payment of)\b/.test(low)) type = "out";

  let amount: number | undefined;
  if (type === "balance") {
    const m = all.match(new RegExp(String.raw`balance[^$]{0,80}` + MONEY, "i"));
    if (m) amount = cents(m[1]);
  }
  if (amount === undefined) {
    const m = all.match(new RegExp(String.raw`(?:amount|of|for|totaling)\s*:?\s*` + MONEY, "i")) || all.match(new RegExp(MONEY));
    if (m) amount = cents(m[1]);
  }
  const l4 = all.match(/(?:ending(?:\s+in|\s+with)?|ending:|last four(?: digits)?(?: of)?|x{2,}|\*{2,}|#)\s*:?\s*(\d{4})\b/i)
    || all.match(/(?:account|acct|card)[^\d$\n]{0,30}(\d{4})\b/i);
  const mer = all.match(/(?:merchant|description|payee|location)\s*(?:name)?\s*:\s*([^\n$]{2,60})/i)
    || all.match(/\b(?:at|to|from)\s+([A-Z0-9][A-Za-z0-9 &*'#.,\-\/]{2,40}?)(?=\s+(?:on|for|in the amount|was|has)\b|\.\s|\n|$)/);
  const merchant = mer ? mer[1].replace(/\s+/g, " ").replace(/[.,]$/, "").trim() : undefined;
  return { type, amount, last4: l4 ? l4[1] : undefined, merchant };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const key = req.headers.get("x-pos-key") || "";
  if (key.length < 20) return json({ error: "Missing key" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: who } = await sb.from("bank_mail_keys").select("user_id").eq("key_hash", await sha256(key)).maybeSingle();
  if (!who) return json({ error: "Unknown key" }, 401);
  const uid = who.user_id as string;

  const body = await req.json().catch(() => ({}));
  const list = (Array.isArray(body.messages) ? body.messages : []).slice(0, 50).filter((m: Record<string, unknown>) =>
    m && typeof m.id === "string" && /^[\w-]{1,100}$/.test(m.id) && /regions\.com/i.test(String(m.from || "")));
  if (body.dry) return json({ ok: true, parsed: list.map((m: Record<string, string>) => ({ id: m.id, subject: m.subject, ...parse(m.subject, m.body) })) });
  if (!list.length) return json({ ok: true, received: 0 });

  // only the ones not seen before
  const { data: seen } = await sb.from("bank_mail").select("id").eq("user_id", uid).in("id", list.map((m: { id: string }) => m.id));
  const known = new Set((seen || []).map((r: { id: string }) => r.id));
  const fresh = list.filter((m: { id: string }) => !known.has(m.id));
  const { data: accts } = await sb.from("fin_docs").select("id,data").eq("user_id", uid).eq("kind", "accounts");
  const byLast4 = (l4?: string) => (l4 ? (accts || []).find((a: { data: { last4?: string[] } }) => (a.data.last4 || []).includes(l4)) : undefined);

  let txns = 0, balances = 0, unread = 0;
  for (const m of fresh) {
    const at = Number(m.date) || Date.now();
    const p = parse(String(m.subject || ""), String(m.body || ""));
    const acct = byLast4(p.last4);
    let status = "unread";
    if (p.type === "skip") status = "ignored";
    else if ((p.type === "out" || p.type === "in") && p.amount) {
      const data = {
        amount: p.amount, merchant: p.merchant || (p.type === "in" ? "Deposit" : "Card or withdrawal"), accountId: acct ? acct.id : null,
        at, dir: p.type, bucketId: null, source: "email", mailId: m.id, alert: String(m.subject || "").slice(0, 120), createdAt: Date.now(), example: false,
      };
      const { error } = await sb.from("fin_docs").insert({ user_id: uid, id: `mail-${m.id}`, kind: "txns", data });
      status = error ? "error" : "txn";
      if (!error) txns++;
    } else if (p.type === "balance" && p.amount !== undefined && acct) {
      const { error } = await sb.from("fin_docs").update({ data: { ...acct.data, balance: p.amount, balanceAt: at, example: false }, updated_at: new Date().toISOString() })
        .eq("user_id", uid).eq("id", acct.id);
      status = error ? "error" : "balance";
      if (!error) balances++;
    }
    if (status === "unread") unread++;
    await sb.from("bank_mail").insert({
      user_id: uid, id: m.id, received_at: new Date(at).toISOString(), sender: String(m.from || "").slice(0, 200),
      subject: String(m.subject || "").slice(0, 300), body: String(m.body || "").slice(0, 12000), parsed: p, status,
    });
  }
  return json({ ok: true, received: list.length, fresh: fresh.length, txns, balances, unread });
});
