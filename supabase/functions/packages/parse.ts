// Reading tracking numbers, shipping emails and Track123's answers. No imports, so it can be tested on its own.
/* ---------- tracking numbers: which carrier, and where to see it on their site ---------- */
export function carrierOf(n: string): string | null {
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return "UPS";
  if (/^TBA\d{9,15}$/.test(n)) return "Amazon";
  if (/^(9[2345]\d{20}|9[2345]\d{24}|[A-Z]{2}\d{9}US|420\d{5}9[2345]\d{20})$/.test(n)) return "USPS";
  if (/^(\d{12}|\d{15}|\d{20}|96\d{20})$/.test(n)) return "FedEx";
  if (/^\d{10}$/.test(n)) return "DHL";
  return null;
}
export function trackUrl(carrier: string | null, n: string) {
  if (carrier === "UPS") return `https://www.ups.com/track?tracknum=${n}`;
  if (carrier === "USPS") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (carrier === "FedEx") return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (carrier === "DHL") return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
  if (carrier === "Amazon") return "https://www.amazon.com/progress-tracker/package";
  return `https://www.track123.com/track?trackNos=${n}`;
}
export const clean = (n: string) => String(n || "").toUpperCase().replace(/[\s-]/g, "");

/* ---------- reading a shipping email: tracking numbers, what it is, when it's due ---------- */
const NUM = /\b(1Z[0-9A-Z]{16}|TBA\d{9,15}|9[2345]\d{20}(?:\d{4})?|[A-Z]{2}\d{9}US|\d{12}|\d{15}|\d{20}|96\d{20})\b/g;
export function fromEmail(subject: string, body: string) {
  const text = `${subject}\n${body}`;
  const found = new Map<string, string | null>();
  for (const m of text.matchAll(NUM)) {
    const n = clean(m[1]);
    const c = carrierOf(n);
    // a bare run of digits only counts next to tracking words (order numbers and phone numbers look the same)
    if (/^\d+$/.test(n)) {
      const near = text.slice(Math.max(0, (m.index || 0) - 60), m.index || 0);
      if (!/track(ing)?\s*(number|no\.?|#|id)?\s*:?\s*$|tracking|fedex|usps|dhl/i.test(near) || /phone|tel|call|fax/i.test(near)) continue;
    }
    if (c) found.set(n, c);
  }
  const eta = (text.match(/(?:estimated|expected|scheduled|arriving|delivery)[^\d]{0,40}?(20\d\d-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\w+\s+\d{1,2}(?:,\s*20\d\d)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,\s*20\d\d)?)/i) || [])[1] || null;
  const item = (text.match(/^\s*(.{3,60}?)\s+X\s+\d+\s*$/m) || text.match(/Contents:\s*\n?\s*(.{3,60})/i) || [])[1] || null;
  const order = (text.match(/order\s*(?:number|#|no\.?)?\s*:?\s*#?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/i) || [])[1] || null;
  return { numbers: [...found.entries()].map(([n, c]) => ({ n, carrier: c })), eta, item: item ? item.trim() : null, order };
}
export function etaDate(s: string | null, at: number): string | null {
  if (!s) return null;
  if (/^20\d\d-\d\d-\d\d$/.test(s)) return s;
  const y = new Date(at).getFullYear();
  const d = new Date(/\d{4}/.test(s) ? s : `${s} ${y}`);
  return isNaN(+d) ? null : d.toISOString().slice(0, 10);
}

/* ---------- Track123's answer, read without assuming too much about its shape ---------- */
export type Ev = { at: number; wall: string | null; text: string; place: string; city: string; state: string; country: string };
const STATES: Record<string, string> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };
const CODES = new Set(Object.values(STATES));
function stateOf(s: string): string {
  const t = String(s || "");
  for (const m of t.matchAll(/\b([A-Z]{2})\b/g)) if (CODES.has(m[1])) return m[1];
  const low = t.toLowerCase();
  for (const [name, code] of Object.entries(STATES)) if (low.includes(name)) return code;
  return "";
}
const timeOf = (v: unknown): number => {
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : 0;
  if (typeof v !== "string" || !/\d{4}|\d{1,2}[/-]\d{1,2}/.test(v)) return 0;
  const t = Date.parse(v.includes("T") || /[+-]\d\d:?\d\d$|Z$/.test(v) ? v : v.replace(" ", "T"));
  return isNaN(t) ? 0 : t;
};
export const pick = (o: Record<string, unknown>, re: RegExp) => { for (const [k, v] of Object.entries(o)) if (re.test(k) && v != null && v !== "") return v; return undefined; };
// the same, for a word (not a list or an object)
const pickStr = (o: Record<string, unknown>, re: RegExp) => { for (const [k, v] of Object.entries(o)) if (re.test(k) && (typeof v === "string" || typeof v === "number") && v !== "") return v; return undefined; };
// a time with no zone ("2026-10-11 14:20:00") is the local time where it happened: kept as written for showing
const wallOf = (v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(v.trim()) ? v.trim().replace("T", " ").slice(0, 16) : null);
function eventOf(o: Record<string, unknown>): Ev | null {
  // the event's own time (not its time zone); a UTC copy, when there is one, gives the exact moment
  const tv = pickStr(o, /^(?!.*(zone|utc)).*(time|date)/i);
  const at = timeOf(pickStr(o, /zero\s*utc|utc$/i)) || timeOf(tv), wall = wallOf(tv);
  const text = String(pickStr(o, /detail|desc|message|statusText|^event$|^status$|content|info/i) ?? "").trim();
  if (!at || !text) return null;
  const addr = pick(o, /address|location|place|area/i);
  const addrText = typeof addr === "string" ? addr : addr && typeof addr === "object" ? Object.values(addr as Record<string, unknown>).filter((x) => typeof x === "string").join(", ") : "";
  const city = String(pickStr(o, /^city$/i) ?? (addr && typeof addr === "object" ? pick(addr as Record<string, unknown>, /city/i) : "") ?? "");
  const st = String(pickStr(o, /^(state|province|region)$/i) ?? (addr && typeof addr === "object" ? pick(addr as Record<string, unknown>, /state|province/i) : "") ?? "");
  const country = String(pickStr(o, /^country/i) ?? "");
  // just the country ("US") isn't a place on the map
  const bare = (x: string) => (/^(us|usa|united states( of america)?)$/i.test(x.trim()) ? "" : x);
  const place = bare([city, st].filter(Boolean).join(", ") || addrText);
  const state = (st && CODES.has(st.toUpperCase()) ? st.toUpperCase() : stateOf(st)) || stateOf(place) || stateOf(text);
  const cityName = city || (place ? place.split(",")[0].trim() : "");
  return { at, wall, text, place: place.trim(), city: cityName, state, country };
}
// every list inside the answer that looks like a run of tracking events
export function eventsIn(t: unknown): Ev[] {
  const out: Ev[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const evs = v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? eventOf(x as Record<string, unknown>) : null)).filter(Boolean) as Ev[];
      if (evs.length && evs.length >= v.length / 2) out.push(...evs);
      else for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(t, 0);
  const seen = new Set<string>();
  return out.filter((e) => { const k = e.at + "|" + e.text; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.at - a.at);
}
export function trackingsIn(j: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (typeof (o.trackNo ?? o.trackingNumber ?? o.trackNumber) === "string" && Object.keys(o).length > 2) { out.push(o); return; }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(j, 0);
  return out;
}
// what stage it's at
export function stageOf(status: string, latest: string): string {
  const s = `${status} ${latest}`.toLowerCase();
  if (/out[\s_-]*for[\s_-]*delivery|with delivery courier|on vehicle/.test(s)) return "out";
  if (/(^|\W)delivered|delivered_|signed|picked up by (the )?(customer|recipient)/.test(s) && !/not delivered|undeliver|attempt/.test(s)) return "delivered";
  if (/exception|fail|undeliver|returned|return to sender|alert|delay|held|damage/.test(s)) return "exception";
  // just registered (INIT) or nothing from the carrier yet (NO_RECORD): it hasn't had its first scan
  if (/(^|\s)init(\s|$)|no[\s_]*record|info[\s_]*received|label|pre[\s_-]*transit|not[\s_]*found|pending|created|awaiting|order processed|shipping label/.test(s)) return "label";
  return "transit";
}
export function readTracking(t: Record<string, unknown>) {
  const evs = eventsIn(t);
  const status = String(pickStr(t, /^transitStatus$/i) ?? pickStr(t, /^(delivery|package|tracking)?status$/i) ?? "");
  const sub = String(pickStr(t, /subStatus/i) ?? "");
  let eta: string | null = null;
  const findEta = (v: unknown, depth: number) => {
    if (eta || depth > 4 || !v || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/expect|estimat|eta|scheduled|promis/i.test(k)) {
        const v = typeof x === "object" && x ? pick(x as Record<string, unknown>, /time|date|start|end/i) : x;
        if (typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v)) { eta = v.slice(0, 10); return; }
        const ms = timeOf(v);
        if (ms) { eta = new Date(ms - 4 * 3600e3).toISOString().slice(0, 10); return; }
      }
      if (x && typeof x === "object" && !Array.isArray(x)) findEta(x, depth + 1);
    }
  };
  findEta(t, 0);
  const latest = evs[0] || null;
  return { status, sub, eta, events: evs.slice(0, 60), latest, stage: stageOf(status + " " + sub, latest ? latest.text : "") };
}

