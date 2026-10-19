# POS — Personal Operating System

A personal operating system for a wall iPad, phone and PC: tasks that feed a calendar, Google Calendar events, finance (the former Split Ledger), weather, and more to come.

- `index.html` is the app shell: sign-in, tasks, calendar, weather, settings. Data lives in Supabase.
- `finance.js` / `finance.css` are the Finance section: accounts, savings goals, spending limits, charges to approve. Its overview tracks net worth day by day (`worth` docs in `fin_docs`, one per month) and splits each month's take-home into needs, wants and saved.
- `focus.js` / `focus.css` are Focus: one thing full screen, counting down to the end of its calendar time, rolling into the next thing on the calendar. Opened from a task's sheet or the Focus button on what's on now.
- `version.json` and the `VERSION` constant in `index.html` must always match, or open copies reload in a loop.
- Apps with sections get a sidebar (`#side` in `index.html`): the NERV tile back to Home, a fold button, then the sections. A module offers it with a `side()` export.
- `car.js` / `car.css` are the Car section: services and oil changes, mileage readings (the odometer is estimated between them), next oil change, notes. Stored in the general `records` table.
- `supabase/functions/gcal` reads a private Google Calendar address and returns events (read-only).
- `supabase/functions/bank-mail` takes Regions alert emails and Express Oil receipts (sent by `apps-script.gs`, a Google Apps Script in the owner's Gmail). Alerts become Finance charges, deposits and balance updates; receipt PDFs (read by `receipt.ts`) become Car services.
- `version.json` changes on every publish; open copies of the app notice and reload themselves.
- `layout.js` lays screens out from the Supabase `layouts` table (per screen and per device: which widgets, their order, size and filters), live by realtime. A screen with no row keeps its built-in layout. Home's row also orders and hides the app icons and brings back the card column. Widget ids are listed in `widgets/catalog.json`; each module offers its cards through a `widgets()` map. New widget types go in `widgets/` and are listed in `widgets/manifest.json`. A device can be named once with `?device=wall-ipad` so it gets its own layout.
- `remote.js` lets the assistant drive open copies live: each copy registers in the `devices` table (name `ipad`, `phone`, `pc`, or its `?device=` name; its screen; last seen and used) and listens to `commands` by realtime: open a screen, show an item, switch a view, scroll to a widget. The copy answers in its own `devices` row. Commands older than 15 seconds are ignored, and a copy never jumps away while you're typing.

Live at https://colwkr.github.io/Hub/ (GitHub Pages, `main` branch).
