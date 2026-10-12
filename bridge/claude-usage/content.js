// While a claude.ai tab is open, read the usage every 2 minutes and hand it to the extension.
// This tab never sees the POS key; it only passes the percentages along.
/* global chrome, CU */
(() => {
  async function tick() {
    if (document.visibilityState === 'hidden') return;
    try { chrome.runtime.sendMessage({ type: 'usage', limits: await CU.read() }); } catch (e) { /* the timer in the background keeps going */ }
  }
  setTimeout(tick, 3000);
  setInterval(tick, 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
})();
