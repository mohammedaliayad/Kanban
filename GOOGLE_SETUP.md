# Connect Orbit Ai to Google Calendar and Google Tasks

Do these steps once, in this order. It takes about 15 minutes. Paste the keys into the settings pages shown below. Never paste them into the chat.

## What syncs where

| In Orbit Ai | In Google (that area's account) |
|---|---|
| Task on a day **with a time** | Calendar event at that time |
| Task on a day **without a time** | Google Task due that day; ticked off when you tick it in Orbit |
| Task with a **due date** | All-day calendar event, with emails 14, 7, 3, 2 and 1 days before |

Accounts: Life → ma@ayad.family, iDlvr → ma@idlvr.com.au, Rockbuild → ma@rockbuild.co.
Sync goes from Orbit to Google. Changes you make directly in Google don't come back into Orbit.

## Part 1: Google Cloud (signed in as ma@idlvr.com.au)

1. Go to https://console.cloud.google.com. Click the project picker at the top, then **New project**. Name it **Orbit Ai** and click **Create**. Make sure it's selected.
2. Search for **Google Calendar API** and click **Enable**. Then search for **Google Tasks API** and click **Enable**.
3. Search for **Google Auth Platform** (or "OAuth consent screen") and click **Get started**.
   - App name: **Orbit Ai**. Support email: your email.
   - Audience: **External**.
   - Contact email: your email. Agree, then **Create**.
4. In the left menu, click **Audience**, then **Publish app**, then **Confirm**. This step matters: if you skip it, Google disconnects the sync every 7 days.
5. In the left menu, click **Clients**, then **Create client**.
   - Application type: **Web application**. Name: **Orbit Ai**.
   - Under **Authorised redirect URIs**, click **Add URI** and paste:
     `https://scnxwvkvpfzuaazxhfrs.supabase.co/functions/v1/google-oauth`
   - Click **Create**. Keep the window showing the **Client ID** and **Client secret** open for Part 2.

## Part 2: Supabase

1. **SQL Editor**, then **New query**. Paste all of [supabase/google.sql](https://github.com/mohammedaliayad/Kanban/blob/main/supabase/google.sql) and click **Run**.
2. **Edge Functions**, then **Secrets** (or Project Settings, then Edge Functions). Add three secrets:
   - `GOOGLE_CLIENT_ID` = the Client ID from Google
   - `GOOGLE_CLIENT_SECRET` = the Client secret from Google
   - `APP_URL` = `https://orbitai.com.au`
3. **Edge Functions**, then **Deploy a new function**, then **Via Editor**.
   - Name it exactly `google-oauth`. Delete the sample code, paste all of [google-oauth/index.ts](https://github.com/mohammedaliayad/Kanban/blob/main/supabase/functions/google-oauth/index.ts) (use the **Raw** button, then copy everything), and click **Deploy**.
   - Open the function's **Details** or **Settings**, turn **off** "Verify JWT" / "Enforce JWT verification", and save.
4. Do step 3 again for a function named exactly `google-sync`, using [google-sync/index.ts](https://github.com/mohammedaliayad/Kanban/blob/main/supabase/functions/google-sync/index.ts). Turn **off** Verify JWT for this one too.

## Part 3: In Orbit Ai

1. Tap **Google** (next to Edit boards).
2. Tap **Connect** next to **Life** and sign in as **ma@ayad.family**.
   - Google will say "Google hasn't verified this app". That's expected, because it's your own private app. Tap **Advanced**, then **Go to Orbit Ai**, then **Continue**, and allow access.
3. Do the same for **iDlvr** (ma@idlvr.com.au) and **Rockbuild** (ma@rockbuild.co).

Your existing tasks for each area get copied across as soon as you connect it.

If any account says it's blocked by your organisation, that Google Workspace's admin settings need to allow the app. Tell Claude which account it was.
