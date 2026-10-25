// Connects a Google account to one Orbit Ai area. Turn OFF "Verify JWT" for this function:
// Google's redirect back here carries no Supabase token, so the function checks the user itself.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = Deno.env.get("APP_URL") || "https://orbitai.com.au";
const REDIRECT = `${SB_URL}/functions/v1/google-oauth`;
const SCOPES = "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // Google sends the user back here after they approve.
  if (req.method === "GET" && url.searchParams.get("state")) {
    const back = (msg: string) => Response.redirect(`${APP_URL}/?google=${encodeURIComponent(msg)}`, 302);
    const { data: st } = await admin.from("google_oauth_states").select("*").eq("state", url.searchParams.get("state")).maybeSingle();
    if (!st) return back("expired");
    await admin.from("google_oauth_states").delete().eq("state", st.state);
    const code = url.searchParams.get("code"); if (!code) return back("cancelled");
    const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }) }).then(r => r.json());
    if (!tok.refresh_token) return back("no-refresh-token");
    const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then(r => r.json());
    await admin.from("google_accounts").upsert({ user_id: st.user_id, board: st.board, email: info.email, refresh_token: tok.refresh_token, updated_at: new Date().toISOString() });
    // Push this area's existing tasks across now.
    const { data: rows } = await admin.from("cards").select("id, doc").eq("user_id", st.user_id);
    const ids = (rows || []).filter(r => r.doc?.board === st.board).map(r => r.id);
    await fetch(`${SB_URL}/functions/v1/google-sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }).catch(() => {});
    return back("connected");
  }

  // Calls from the app: who is signed in?
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "not signed in" }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === "status") {
    const { data } = await admin.from("google_accounts").select("board, email").eq("user_id", user.id);
    return json({ accounts: data || [] });
  }
  if (body.action === "disconnect") {
    await admin.from("google_accounts").delete().eq("user_id", user.id).eq("board", body.board);
    await admin.from("google_sync_map").delete().eq("user_id", user.id).eq("board", body.board);
    return json({ ok: true });
  }
  if (body.action === "start") {
    const state = crypto.randomUUID();
    await admin.from("google_oauth_states").insert({ state, user_id: user.id, board: body.board });
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state });
    if (body.hint) q.set("login_hint", body.hint);
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
  }
  return json({ error: "unknown action" }, 400);
});
