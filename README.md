# POS — Personal Operating System

A personal operating system for a wall iPad, phone and PC: tasks that feed a calendar, Google Calendar events, finance (the former Split Ledger), weather, and more to come.

- `index.html` is the app shell: sign-in, tasks, calendar, weather, settings. Data lives in Supabase.
- `finance.js` / `finance.css` are the Finance section: accounts, savings goals, spending limits, charges to approve.
- `supabase/functions/gcal` reads a private Google Calendar address and returns events (read-only).
- `version.json` changes on every publish; open copies of the app notice and reload themselves.

Live at https://colwkr.github.io/Hub/ (GitHub Pages, `main` branch).
