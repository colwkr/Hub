// Express Oil Change receipts (the PDF on "Invoice Enclosed" emails) → one car service record.
// No imports here, so the same code can be checked outside the edge runtime.

type Item = { str?: string; transform?: number[]; width?: number };
type PdfDoc = { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> };

// The PDF's text laid back out in lines, columns kept apart by three spaces (like pdftotext -layout).
export async function pdfLines(pdf: PdfDoc): Promise<string> {
  const out: string[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 3); n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    const words = (items as Item[]).filter((i) => i.str && i.str.trim() && i.transform)
      .map((i) => ({ s: i.str!.trim(), x: i.transform![4], y: i.transform![5], w: i.width || 0 }));
    const rows: { y: number; ws: typeof words }[] = [];
    for (const w of words.sort((a, b) => b.y - a.y)) {
      const r = rows.find((r) => Math.abs(r.y - w.y) < 2.5);
      if (r) r.ws.push(w); else rows.push({ y: w.y, ws: [w] });
    }
    for (const r of rows.sort((a, b) => b.y - a.y)) {
      let line = "", end: number | null = null;
      for (const w of r.ws.sort((a, b) => a.x - b.x)) {
        if (end !== null) line += w.x - end > 9 ? "   " : " ";
        line += w.s; end = w.x + w.w;
      }
      out.push(line);
    }
  }
  return out.join("\n");
}

// Wall-clock time in South Carolina → epoch ms (handles daylight saving).
export function easternMs(y: number, mo: number, d: number, h = 12, mi = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess + (guess - shown);
}

const SKIP = /LABOR|FEE\b|TAX|TORQUE|FT LBS|LIMIT & FLUIDS|API RATING|ACEA|DISCOUNT|COUPON|SHOP SUPPL/;
function nice(s: string) {
  const t = s.replace(/\s+/g, " ").trim().toLowerCase().replace(/\b([a-z]*\d[a-z0-9]*)\b/g, (m) => m.toUpperCase());
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export type Receipt = {
  at: number | null; miles: number | null; cost: number | null; card: string | null; invoice: string | null; vin: string | null;
  nextMiles: number | null; nextAt: number | null; type: "oil" | "other"; title: string; items: string[]; recs: string[]; codes: string | null;
};

export function parseReceipt(text: string): Receipt {
  const t = text || "";
  const date = t.match(/\bDATE\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i);
  let at: number | null = null;
  if (date) {
    let h = date[4] ? +date[4] % 12 : 12;
    if (date[6] && /pm/i.test(date[6])) h += 12;
    at = easternMs(+date[3], +date[1], +date[2], date[4] ? h : 12, date[5] ? +date[5] : 0);
  }
  const miles = t.match(/\bMILEAGE\s+(\d{3,7})\b/) || t.match(/\b(\d{3,7})\s*MILEAGE\b/);
  const total = t.match(/(?<![A-Z])TOTAL\s+\$?\s*((?:\d{1,3},)*\d+\.\d{2})/);
  const card = t.match(/\b(?:VISA|MASTERCARD|MC|AMEX|DISCOVER|DEBIT|CREDIT)\s+(?:[X*]+)?(\d{4})\b/);
  const inv = t.match(/INVOICE NO\s+([\d-]{4,20})/);
  const vin = t.match(/\bVIN\s+([A-HJ-NPR-Z0-9]{17})\b/);
  const next = t.match(/next service on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+or\s+(\d{3,7})/i);
  const hist = t.match(/^\s*(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d{3,7})\s+([A-Z0-9 ]+)$/m);

  // the charged lines: description, quantity, price
  const items: string[] = [], recs: string[] = [];
  let oil = false;
  for (const line of t.split("\n")) {
    const segs = line.split(/\s{3,}/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i + 2 < segs.length + 0; i++) {
      if (!/^\d+\.\d{2}$/.test(segs[i + 1] || "") || !/^\d+\.\d{2}$/.test(segs[i + 2] || "")) continue;
      const desc = segs[i].replace(/\s+/g, " ");
      if (!/^[A-Z0-9][A-Z0-9 #&.,'\/()-]{2,60}$/.test(desc)) continue;
      const qty = parseFloat(segs[i + 1]);
      if (/^REC\.?\s/.test(desc)) { recs.push(nice(desc.replace(/^REC\.?\s+/, ""))); continue; }
      if (/OIL CHANGE/.test(desc)) oil = true;
      if (SKIP.test(desc)) continue;
      items.push(nice(desc) + (/\b\d?W-?\d\d\b/.test(desc) && qty > 1.5 && qty < 12 ? `, ${+qty.toFixed(2)} qt` : ""));
    }
  }
  // the checklist's own recommendations ("Tire Rotate & Balance Due?   Rec R&B"), when no charged line said it already
  for (const m of t.matchAll(/(?:Check\s+)?([A-Z][A-Za-z &/()]+?)(?:\s+Due\?)?\s{2,}Rec\b[^\n]*/g)) {
    const what = nice(m[1]);
    const key = what.toLowerCase().split(" ").find((w) => w.length > 3) || "";
    if (key && !recs.some((r) => r.toLowerCase().includes(key.slice(0, 5)))) recs.push(what);
  }
  const type = oil ? "oil" : "other";
  return {
    at, miles: miles ? +miles[1] : null, cost: total ? Math.round(parseFloat(total[1].replace(/,/g, "")) * 100) : null,
    card: card ? card[1] : null, invoice: inv ? inv[1] : null, vin: vin ? vin[1] : null,
    nextMiles: next ? +next[4] : null, nextAt: next ? easternMs(+next[3], +next[1], +next[2]) : null,
    type, title: oil ? "Oil change" : items[0] || "Service", items, recs, codes: hist && miles && +hist[2] === +miles[1] ? hist[3].trim() : null,
  };
}
