# Orbit Ai (standalone app)

Static site (no build step) backed by Supabase for login, storage and live sync.

Files: `index.html` (the app), `config.js` (Supabase URL + anon key), `schema.sql` (run once in Supabase), `manifest.webmanifest` + `icon-*.png` (home-screen app).

## Setup
1. Supabase: create project (Sydney region). SQL Editor: run `schema.sql`.
2. Project Settings > API: copy Project URL and anon public key into `config.js`.
3. Host the folder (AWS Amplify from the GitHub repo, no build settings needed).
4. Point the domain (VentraIP DNS) at Amplify using the CNAME Amplify gives.
5. Open the site, "Create your account" once, then in Supabase > Authentication > Sign In / Providers turn off "Allow new users to sign up".

Built from the claude.ai board in the project thread "Kanban board for life & businesses"; the board's data model is in project memory (kanban-board).
