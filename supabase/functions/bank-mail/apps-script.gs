/**
 * POS mail: sends each new Regions alert and Express Oil receipt in this Gmail to POS, about once a minute.
 * Regions alerts become Finance charges and balances; Express Oil receipts (the PDF) become Car services.
 *
 * Set up once, on a computer:
 *   1. Go to script.google.com, signed in as the Gmail that gets the Regions alerts, and choose New project.
 *      (Already have the POS project from before? Open it instead and replace everything in the editor.)
 *   2. Delete what's in the editor, paste all of this in, and save (the disk icon).
 *   3. In the toolbar, pick "setup" from the function list and press Run.
 *   4. Google asks to let it read your email and connect to an outside service. Allow both
 *      (on "Google hasn't verified this app", choose Advanced, then Go to the project).
 * After that it runs on its own. It only reads mail from alert.regions.com and expressoil.com, and never sends or deletes anything.
 */
const POS_URL = 'https://dejcovbqwlrvniitbdqv.supabase.co/functions/v1/bank-mail';
const POS_KEY = 'PASTE_KEY_HERE';
const SENDERS = '(from:alert.regions.com OR from:expressoil.com)';

function setup() {
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('sendAlerts').timeBased().everyMinutes(1).create();
  // start with the last two days, so anything already waiting goes over once
  PropertiesService.getScriptProperties().setProperty('since', String(Date.now() - 2 * 86400000));
  sendAlerts();
  sendOldReceipts();
}

// every Express Oil receipt from the last three years, once; POS fills in the car's service history from them
function sendOldReceipts() {
  const threads = GmailApp.search('from:expressoil.com has:attachment newer_than:3y', 0, 100);
  const messages = [];
  for (const th of threads) for (const m of th.getMessages()) if (/expressoil\.com/i.test(m.getFrom())) messages.push(pack(m));
  send(messages);
}

function pack(m) {
  const msg = { id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: m.getDate().getTime(), body: m.getPlainBody().slice(0, 12000) };
  if (/expressoil\.com/i.test(msg.from)) {
    const pdf = m.getAttachments().filter(a => /pdf/i.test(a.getContentType()) || /\.pdf$/i.test(a.getName()))[0];
    msg.body = msg.body.slice(0, 2000);
    msg.pdf = pdf ? Utilities.base64Encode(pdf.getBytes()) : null;
  }
  return msg;
}

// alerts go over 50 at a time; a receipt (it carries its PDF) goes on its own
function send(messages) {
  const batches = [];
  let cur = [];
  for (const m of messages) {
    if (m.pdf !== undefined) { batches.push([m]); continue; }
    cur.push(m);
    if (cur.length === 50) { batches.push(cur); cur = []; }
  }
  if (cur.length) batches.push(cur);
  for (const b of batches) {
    const res = UrlFetchApp.fetch(POS_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-pos-key': POS_KEY }, payload: JSON.stringify({ messages: b }),
    });
    if (res.getResponseCode() !== 200) { console.log('POS answered ' + res.getResponseCode() + ': ' + res.getContentText()); return false; } // tries again next minute
  }
  return true;
}

function sendAlerts() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('since')) || Date.now() - 86400000;
  // five minutes of overlap in case Gmail is slow to show a message; POS skips anything it has already seen
  const from = since - 5 * 60000;
  const threads = GmailApp.search(SENDERS + ' after:' + Math.floor(from / 1000), 0, 50);
  const messages = [];
  let newest = since;
  for (const th of threads) {
    for (const m of th.getMessages()) {
      const at = m.getDate().getTime();
      if (at < from || !/regions\.com|expressoil\.com/i.test(m.getFrom())) continue;
      messages.push(pack(m));
      newest = Math.max(newest, at);
    }
  }
  if (!messages.length) return;
  if (send(messages)) props.setProperty('since', String(newest));
}
