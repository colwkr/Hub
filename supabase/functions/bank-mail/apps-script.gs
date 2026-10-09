/**
 * POS bank alerts: sends each new Regions alert email in this Gmail to POS, about once a minute.
 *
 * Set up once, on a computer:
 *   1. Go to script.google.com, signed in as the Gmail that gets the Regions alerts, and choose New project.
 *   2. Delete what's in the editor, paste all of this in, and save (the disk icon).
 *   3. In the toolbar, pick "setup" from the function list and press Run.
 *   4. Google asks to let it read your email and connect to an outside service. Allow both
 *      (on "Google hasn't verified this app", choose Advanced, then Go to the project).
 * After that it runs on its own. It only reads mail from alert.regions.com and never sends or deletes anything.
 */
const POS_URL = 'https://dejcovbqwlrvniitbdqv.supabase.co/functions/v1/bank-mail';
const POS_KEY = 'PASTE_KEY_HERE';

function setup() {
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('sendAlerts').timeBased().everyMinutes(1).create();
  // start with the last two days, so anything already waiting goes over once
  PropertiesService.getScriptProperties().setProperty('since', String(Date.now() - 2 * 86400000));
  sendAlerts();
}

function sendAlerts() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('since')) || Date.now() - 86400000;
  // five minutes of overlap in case Gmail is slow to show a message; POS skips anything it has already seen
  const from = since - 5 * 60000;
  const threads = GmailApp.search('from:alert.regions.com after:' + Math.floor(from / 1000), 0, 50);
  const messages = [];
  let newest = since;
  for (const th of threads) {
    for (const m of th.getMessages()) {
      const at = m.getDate().getTime();
      if (at < from) continue;
      messages.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: at, body: m.getPlainBody().slice(0, 12000) });
      newest = Math.max(newest, at);
    }
  }
  if (!messages.length) return;
  for (let i = 0; i < messages.length; i += 50) {
    const res = UrlFetchApp.fetch(POS_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-pos-key': POS_KEY }, payload: JSON.stringify({ messages: messages.slice(i, i + 50) }),
    });
    if (res.getResponseCode() !== 200) { console.log('POS answered ' + res.getResponseCode() + ': ' + res.getContentText()); return; } // tries again next minute
  }
  props.setProperty('since', String(newest));
}
