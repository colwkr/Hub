# Hub

A personal hub for a wall iPad, phone and PC: tasks that feed a calendar, Google Calendar events, weather, and more to come.

- `index.html` is the whole app. It signs in and stores tasks with Supabase.
- `supabase/functions/gcal` reads a private Google Calendar address and returns events (read-only).
- `version.json` changes on every publish; open copies of the app notice and reload themselves.

Hosted with GitHub Pages from the `main` branch.
