// Mirrors Orbit Ai cards into Google. Turn OFF "Verify JWT" for this function (the database calls it).
// It only ever re-reads cards from the database, so calling it can't inject anything.
//   due date        -> all-day calendar event, with emails 14, 7, 3, 2 and 1 days before
//   day + time      -> calendar event at that time
//   day, no time    -> Google Task due that day (ticked off when the card is done)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = Deno.env.get("APP_URL") || "https://orbitai.com.au";
const TZ = "Australia/Sydney";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

type Doc = { title: string; board: string; col: string; due?: string | null; day?: string | null; time?: string | null; endTime?: string | null; note?: string; urgent?: boolean };
type Want = { body: Record<string, unknown>; hash: string };

const tokens = new Map<string, string>();
async function accessToken(userId: string, board: string): Promise<string | null> {
  const key = userId + ":" + board;
  if (tokens.has(key)) return tokens.get(key)!;
  const { data: acc } = await admin.from("google_accounts").select("refresh_token").eq("user_id", userId).eq("board", board).maybeSingle();
  if (!acc) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: acc.refresh_token, grant_type: "refresh_token" }) }).then(r => r.json());
  if (!r.access_token) { console.error("refresh failed", board, r.error); return null; }
  tokens.set(key, r.access_token);
  return r.access_token;
}
const g = (tok: string, method: string, url: string, body?: unknown) =>
  fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

const nextDay = (d: string) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
// Calendar events get a fixed id per card, so two quick saves can't create duplicates.
const eventId = (kind: string, id: string) => [...new TextEncoder().encode("orbit" + kind + id)].map(b => b.toString(16).padStart(2, "0")).join("");
const plusHour = (t: string) => { const [h, m] = t.split(":").map(Number); const e = Math.min(h * 60 + m + 60, 23 * 60 + 59); return `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`; };

function wanted(d: Doc): Record<string, Want> {
  const out: Record<string, Want> = {};
  const open = d.col !== "done";
  const title = (d.urgent ? "⚡ " : "") + d.title;
  const desc = [d.note, `From Orbit Ai: ${APP_URL}`].filter(Boolean).join("\n\n");
  if (d.due && open) {
    const body = { status: "confirmed", summary: "Due: " + title, description: desc, start: { date: d.due }, end: { date: nextDay(d.due) }, transparency: "transparent",
      reminders: { useDefault: false, overrides: [20160, 10080, 4320, 2880, 1440].map(minutes => ({ method: "email", minutes })) } };
    out.due = { body, hash: JSON.stringify([title, d.due, desc]) };
  }
  if (d.day && d.time && open) {
    const end = d.endTime && d.endTime > d.time ? d.endTime : plusHour(d.time);
    const body = { status: "confirmed", summary: title, description: desc, start: { dateTime: `${d.day}T${d.time}:00`, timeZone: TZ }, end: { dateTime: `${d.day}T${end}:00`, timeZone: TZ } };
    out.event = { body, hash: JSON.stringify([title, d.day, d.time, end, desc]) };
  }
  if (d.day && !d.time) {
    const body = { title, notes: desc, due: `${d.day}T00:00:00.000Z`, status: open ? "needsAction" : "completed" };
    out.task = { body, hash: JSON.stringify([title, d.day, desc, open]) };
  }
  return out;
}

async function remove(m: { card_id: string; kind: string; user_id: string; board: string; google_id: string }) {
  const tok = await accessToken(m.user_id, m.board);
  if (tok) {
    const url = m.kind === "task" ? `${TASKS}/${m.google_id}` : `${CAL}/${m.google_id}?sendUpdates=none`;
    const r = await g(tok, "DELETE", url);
    if (!r.ok && r.status !== 404 && r.status !== 410) { console.error("delete failed", r.status, await r.text()); return; }
  }
  await admin.from("google_sync_map").delete().eq("card_id", m.card_id).eq("kind", m.kind);
}

async function syncCard(id: string) {
  const [{ data: row }, { data: maps }] = await Promise.all([
    admin.from("cards").select("user_id, doc").eq("id", id).maybeSingle(),
    admin.from("google_sync_map").select("*").eq("card_id", id),
  ]);
  const existing = new Map((maps || []).map(m => [m.kind, m]));
  if (!row) { for (const m of existing.values()) await remove(m); return; }
  const doc = row.doc as Doc;
  const want = wanted(doc);
  // A done card keeps its past calendar event; everything else not wanted any more is removed.
  for (const [kind, m] of existing) {
    const keep = kind in want && m.board === doc.board;
    const doneEvent = kind === "event" && doc.col === "done" && m.board === doc.board;
    if (!keep && !doneEvent) { await remove(m); existing.delete(kind); }
  }
  const tok = await accessToken(row.user_id, doc.board);
  if (!tok) return; // that area has no Google account connected
  for (const [kind, w] of Object.entries(want)) {
    const m = existing.get(kind);
    if (m && m.hash === w.hash) continue;
    let r: Response;
    if (kind === "task") {
      r = m ? await g(tok, "PATCH", `${TASKS}/${m.google_id}`, w.body) : await g(tok, "POST", TASKS, w.body);
      if (m && (r.status === 404 || r.status === 410)) r = await g(tok, "POST", TASKS, w.body);
    } else {
      const eid = m?.google_id || eventId(kind, id);
      r = await g(tok, "PATCH", `${CAL}/${eid}?sendUpdates=none`, w.body);
      if (r.status === 404 || r.status === 410) r = await g(tok, "POST", `${CAL}?sendUpdates=none`, { id: eid, ...w.body });
      if (r.status === 409) r = await g(tok, "PATCH", `${CAL}/${eid}?sendUpdates=none`, w.body);
    }
    if (!r.ok) { console.error("google write failed", kind, r.status, await r.text()); continue; }
    const res = await r.json();
    await admin.from("google_sync_map").upsert({ card_id: id, kind, user_id: row.user_id, board: doc.board, google_id: res.id, hash: w.hash });
  }
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const ids: string[] = body.ids || (body.id ? [body.id] : []);
  for (const id of ids.slice(0, 500)) { try { await syncCard(String(id)); } catch (e) { console.error("sync error", id, e); } }
  return new Response(JSON.stringify({ synced: ids.length }), { headers: { "Content-Type": "application/json" } });
});
