# POS — Personal Operating System

A personal operating system for a wall iPad, phone and PC: tasks that feed a calendar, Google Calendar events, finance (the former Split Ledger), weather, and more to come.

- `index.html` is the app shell: sign-in, tasks, calendar, weather, settings. Data lives in Supabase.
- `finance.js` / `finance.css` are the Finance section: accounts, savings goals, spending limits, charges to approve.
- `car.js` / `car.css` are the Car section: services and oil changes, mileage readings (the odometer is estimated between them), next oil change, notes. Stored in the general `records` table.
- `supabase/functions/gcal` reads a private Google Calendar address and returns events (read-only).
- `supabase/functions/bank-mail` takes Regions alert emails and Express Oil receipts (sent by `apps-script.gs`, a Google Apps Script in the owner's Gmail). Alerts become Finance charges, deposits and balance updates; receipt PDFs (read by `receipt.ts`) become Car services.
- `version.json` changes on every publish; open copies of the app notice and reload themselves.

Live at https://colwkr.github.io/Hub/ (GitHub Pages, `main` branch).
