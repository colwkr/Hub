// Google Calendar → Hub.
// Reads the signed-in person's private Google Calendar address (iCal) from their settings row,
// expands it into individual events for the requested days, and returns them in their local time.
// Read-only: nothing is ever written back to Google.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import ICAL from "npm:ical.js@1.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DAY = 86400000;
const isDay = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const tz = typeof body.tz === "string" && body.tz.length < 64 ? body.tz : "America/New_York";
    const from = isDay(body.from) ? body.from : new Date().toISOString().slice(0, 10);
    const to = isDay(body.to) ? body.to : from;
    if (Date.parse(to) < Date.parse(from) || Date.parse(to) - Date.parse(from) > 400 * DAY) {
      return json({ error: "Ask for at most 400 days at a time." }, 400);
    }

    // The caller's own settings row; row-level security means nobody can read anyone else's.
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: settings } = await sb.from("settings").select("gcal_ics_url").maybeSingle();
    const url = settings?.gcal_ics_url as string | undefined;
    if (!url) return json({ configured: false, events: [] });
    if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(url)) return json({ error: "That is not a Google Calendar address." }, 400);

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      return json({ configured: true, error: res.status === 404 ? "Google no longer recognizes that calendar address. Copy it again from Google Calendar settings." : `Google Calendar answered ${res.status}.` }, 502);
    }
    const text = await res.text();

    const root = new ICAL.Component(ICAL.parse(text));
    for (const vtz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
    const calName = root.getFirstPropertyValue("x-wr-calname") || "Google Calendar";

    // local date + time in the person's time zone
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const local = (d: Date) => {
      const p: Record<string, string> = {};
      for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
      return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    };
    // generous UTC window around the requested local days; exact filtering happens on local dates below
    const winStart = Date.parse(from + "T00:00:00Z") - 15 * 3600000;
    const winEnd = Date.parse(to + "T00:00:00Z") + DAY + 15 * 3600000;

    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const emit = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null) => {
      const base = { title: item.summary || "(No title)", location: item.location || null, calendar: calName };
      if (start.isDate) {
        // all-day: one entry per day it covers (Google's end date is exclusive)
        const first = start.toString().slice(0, 10);
        const last = end ? end.toString().slice(0, 10) : null;
        let d = first;
        for (let i = 0; i < 400; i++) {
          if (last ? d >= last : i > 0) break;
          if (d >= from && d <= to) {
            const key = `${item.uid}|${d}|all`;
            if (!seen.has(key)) { seen.add(key); out.push({ ...base, id: key, date: d, allDay: true, start: null, mins: null }); }
          }
          d = new Date(Date.parse(d + "T00:00:00Z") + DAY).toISOString().slice(0, 10);
        }
        return;
      }
      const s = start.toJSDate(), e = end ? end.toJSDate() : new Date(s.getTime() + 30 * 60000);
      if (e.getTime() < winStart || s.getTime() > winEnd) return;
      const ls = local(s);
      if (ls.date < from || ls.date > to) return;
      const key = `${item.uid}|${s.toISOString()}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...base, id: key, date: ls.date, allDay: false, start: ls.time, mins: Math.max(1, Math.round((e.getTime() - s.getTime()) / 60000)) });
    };

    const vevents = root.getAllSubcomponents("vevent");
    const exceptions = vevents.filter((v) => v.hasProperty("recurrence-id"));
    for (const v of vevents) {
      if (v.hasProperty("recurrence-id")) continue;
      if (String(v.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") continue;
      const ev = new ICAL.Event(v);
      for (const x of exceptions) if (x.getFirstPropertyValue("uid") === ev.uid) ev.relateException(x);
      if (!ev.isRecurring()) { emit(ev, ev.startDate, ev.endDate); continue; }
      const it = ev.iterator();
      let next: ICAL.Time | null;
      for (let n = 0; n < 20000 && (next = it.next()); n++) {
        const t = next.toJSDate().getTime();
        if (t > winEnd) break;
        const det = ev.getOccurrenceDetails(next);
        if (String(det.item.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") continue;
        if (det.endDate.toJSDate().getTime() < winStart) continue;
        emit(det.item, det.startDate, det.endDate);
      }
    }
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start ?? "").localeCompare(String(b.start ?? "")));
    return json({ configured: true, calendar: calName, events: out });
  } catch (err) {
    return json({ error: "Could not read the calendar.", detail: String(err).slice(0, 300) }, 500);
  }
});
