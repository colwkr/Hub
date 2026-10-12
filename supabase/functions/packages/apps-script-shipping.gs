/**
 * POS packages: sends shipping emails (the ones about an order shipping, with a tracking number) to POS every
 * 10 minutes, so packages show up in POS on their own. POS only keeps the tracking number, what it is, the store and
 * the expected date; it doesn't keep the email.
 *
 * Add it to the same Apps Script project as the POS mail script (it uses that script's POS_KEY):
 *   1. Open script.google.com and the POS project.
 *   2. Next to "Files", press +, choose Script, name it shipping, and paste all of this in. Save.
 *   3. Pick "setupShipping" in the function list and press Run (it looks back two weeks the first time).
 */
const POS_PKG_URL = 'https://dejcovbqwlrvniitbdqv.supabase.co/functions/v1/packages';
const SHIP_QUERY = '(subject:(shipped OR shipping OR "on its way" OR "on the way" OR tracking OR "out for delivery" OR "has shipped" OR "shipment") OR "tracking number")';

function setupShipping() {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === 'sendShipping') ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('sendShipping').timeBased().everyMinutes(10).create();
  PropertiesService.getScriptProperties().setProperty('shipSince', String(Date.now() - 14 * 86400000));
  sendShipping();
}

function sendShipping() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('shipSince')) || Date.now() - 86400000;
  // ten minutes of overlap in case Gmail is slow to show a message; POS skips tracking numbers it already has
  const from = since - 10 * 60000;
  const threads = GmailApp.search(SHIP_QUERY + ' after:' + Math.floor(from / 1000), 0, 40);
  const messages = [];
  let newest = since;
  for (const th of threads) {
    for (const m of th.getMessages()) {
      const at = m.getDate().getTime();
      if (at < from) continue;
      messages.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: at, body: m.getPlainBody().slice(0, 15000) });
      newest = Math.max(newest, at);
    }
  }
  if (!messages.length) return;
  for (let i = 0; i < messages.length; i += 20) {
    const res = UrlFetchApp.fetch(POS_PKG_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-pos-key': POS_KEY }, payload: JSON.stringify({ messages: messages.slice(i, i + 20) }),
    });
    if (res.getResponseCode() !== 200) { console.log('POS answered ' + res.getResponseCode() + ': ' + res.getContentText()); return; } // tries again in 10 minutes
  }
  props.setProperty('shipSince', String(newest));
}
