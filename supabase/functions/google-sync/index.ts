// Mirrors Orbit Ai cards into Google. Turn OFF "Verify JWT" for this function (the database calls it).
// It only ever re-reads cards from the database, so calling it can't inject anything.
//   due date        -> all-day calendar event, with emails 14, 7, 3, 2 and 1 days before
//   day + time      -> calendar event at that time
//   day, no time    -> Google Task due that day (ticked off when the card is done)
// The app also calls it with {action:"pull"} to bring Google into Orbit: events and tasks made in Google
// become cards (src "gcal" / "gtask"), and edits or ticks made in Google to Orbit's own items come back.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = Deno.env.get("APP_URL") || "https://orbitai.com.au";
const TZ = "Australia/Sydney";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
const LISTS = "https://tasks.googleapis.com/tasks/v1";
// Tasks in the default list keep their plain id; tasks in other lists are stored as "<listId>~<taskId>".
const taskUrl = (gid: string) => gid.includes("~") ? `${LISTS}/lists/${gid.split("~")[0]}/tasks/${gid.split("~")[1]}` : `${TASKS}/${gid}`;

type Doc = { title: string; board: string; col: string; due?: string | null; day?: string | null; endDay?: string | null; time?: string | null; endTime?: string | null; note?: string; urgent?: boolean; src?: string; guests?: string[]; prevCol?: string; doneAt?: string; [k: string]: unknown };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
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
  // Cards that came from Google write back to the same event or task, without Orbit's footer.
  if (d.src === "gcal" && d.day) {
    const end = d.time ? (d.endTime && d.endTime > d.time ? d.endTime : plusHour(d.time)) : "";
    const body = d.time
      ? { summary: d.title, description: d.note || "", start: { dateTime: `${d.day}T${d.time}:00`, timeZone: TZ }, end: { dateTime: `${d.day}T${end}:00`, timeZone: TZ } }
      : { summary: d.title, description: d.note || "", start: { date: d.day }, end: { date: nextDay(d.endDay && d.endDay > d.day ? d.endDay : d.day) } };
    const guests = (d.guests || []).slice().sort();
    if (guests.length) (body as Record<string, unknown>).attendees = guests.map(email => ({ email }));
    out.event = { body, hash: JSON.stringify(["g", d.title, d.day, d.time || "", end, d.endDay || "", d.note || "", guests]) };
    return out;
  }
  if (d.src === "gtask") {
    const open = d.col !== "done";
    const body: Record<string, unknown> = { title: d.title, notes: d.note || "", status: open ? "needsAction" : "completed" };
    if (d.day) body.due = `${d.day}T00:00:00.000Z`;
    out.task = { body, hash: JSON.stringify(["g", d.title, d.day || "", d.note || "", open]) };
    return out;
  }
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
    const guests = (d.guests || []).slice().sort();
    const body: Record<string, unknown> = { status: "confirmed", summary: title, description: desc, start: { dateTime: `${d.day}T${d.time}:00`, timeZone: TZ }, end: { dateTime: `${d.day}T${end}:00`, timeZone: TZ } };
    if (guests.length) body.attendees = guests.map(email => ({ email }));
    out.event = { body, hash: JSON.stringify(guests.length ? [title, d.day, d.time, end, desc, guests] : [title, d.day, d.time, end, desc]) };
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
    const url = m.kind === "task" ? taskUrl(m.google_id) : `${CAL}/${m.google_id}?sendUpdates=none`;
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
  // Items the pull just wrote already match Google: stop before touching Google at all.
  if (Object.entries(want).every(([kind, w]) => existing.get(kind)?.hash === w.hash)) return;
  const tok = await accessToken(row.user_id, doc.board);
  if (!tok) return; // that area has no Google account connected
  for (const [kind, w] of Object.entries(want)) {
    const m = existing.get(kind);
    if (m && m.hash === w.hash) continue;
    let r: Response;
    if (kind === "task") {
      r = m ? await g(tok, "PATCH", taskUrl(m.google_id), w.body) : await g(tok, "POST", TASKS, w.body);
      if (m && (r.status === 404 || r.status === 410)) r = await g(tok, "POST", TASKS, w.body);
    } else {
      const eid = m?.google_id || eventId(kind, id);
      const su = (w.body as { attendees?: unknown[] }).attendees?.length ? "all" : "none";
      r = await g(tok, "PATCH", `${CAL}/${eid}?sendUpdates=${su}`, w.body);
      if (r.status === 404 || r.status === 410) r = await g(tok, "POST", `${CAL}?sendUpdates=${su}`, { id: eid, ...w.body });
      if (r.status === 409) r = await g(tok, "PATCH", `${CAL}/${eid}?sendUpdates=${su}`, w.body);
    }
    if (!r.ok) { console.error("google write failed", kind, r.status, await r.text()); continue; }
    const res = await r.json();
    await admin.from("google_sync_map").upsert({ card_id: id, kind, user_id: row.user_id, board: doc.board, google_id: res.id, hash: w.hash });
  }
}

// ---- Google -> Orbit -------------------------------------------------------------------------
const local = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const prevDay = (d: string) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
const ORBIT_PREFIX = eventId("", "").slice(0, 10); // hex of "orbit"
async function listAll(tok: string, url: string, key: string) {
  const out: any[] = []; let page = "";
  for (let i = 0; i < 20; i++) {
    const r = await g(tok, "GET", url + (page ? `&pageToken=${page}` : ""));
    if (!r.ok) { console.error("list failed", r.status, await r.text()); return null; }
    const j = await r.json(); out.push(...(j[key] || [])); page = j.nextPageToken; if (!page) break;
  }
  return out;
}
// Fields of a Google event as Orbit stores them.
function fromEvent(e: any) {
  if (e.start?.dateTime) { const s = local(e.start.dateTime), en = local(e.end?.dateTime || e.start.dateTime); return { day: s.day, time: s.time, endTime: en.day === s.day ? en.time : "23:59", endDay: null }; }
  const day = e.start?.date, last = e.end?.date ? prevDay(e.end.date) : day;
  return { day, time: null, endTime: null, endDay: last && last > day ? last : null };
}
const guestsOf = (e: any) => (e.attendees || []).filter((a: any) => !a.self && !a.resource).map((a: any) => String(a.email).toLowerCase()).sort();
// Google Meet (or other video call) link on the event, if any.
const meetOf = (e: any) => { const u = e.hangoutLink || (e.conferenceData?.entryPoints || []).find((p: any) => p.entryPointType === "video")?.uri || ""; return /^https:\/\//.test(u) ? u : null; };
const strip = (t: string) => String(t || "").replace(/^Due: /, "").replace(/^⚡ /, "");

async function pull(userId: string) {
  const { data: accs } = await admin.from("google_accounts").select("board").eq("user_id", userId);
  const { data: rows } = await admin.from("cards").select("id, doc").eq("user_id", userId);
  const { data: maps } = await admin.from("google_sync_map").select("*").eq("user_id", userId);
  const cards = new Map((rows || []).map(r => [r.id, r.doc as Doc]));
  const byGoogle = new Map((maps || []).map(m => [m.board + ":" + m.kind[0] + ":" + m.google_id, m]));
  const now = new Date(), from = new Date(now.getTime() - 14 * 864e5).toISOString(), to = new Date(now.getTime() + 183 * 864e5).toISOString();
  let changed = 0;
  // What each account returned, shown in the app so missing items can be traced.
  const report: any[] = [];
  // Writes are queued and sent in bulk at the end: a big calendar has thousands of event instances, and one
  // request per item runs the function out of time. Map rows carry the hash Orbit would send, so the push side sees nothing to do.
  const mapQ = new Map<string, any>(), cardQ = new Map<string, any>(), dropQ = new Set<string>();
  const put = async (id: string, doc: Doc, kind: string, googleId: string) => {
    const w = wanted(doc)[kind];
    mapQ.set(id + ":" + kind, { card_id: id, kind, user_id: userId, board: doc.board, google_id: googleId, hash: w?.hash || null });
    cardQ.set(id, { id, user_id: userId, doc, updated_at: new Date().toISOString() });
    dropQ.delete(id); cards.set(id, doc); changed++;
  };
  const save = (id: string, doc: Doc) => { cardQ.set(id, { id, user_id: userId, doc, updated_at: new Date().toISOString() }); cards.set(id, doc); changed++; };
  const unmap = async (id: string, kind: string) => { mapQ.delete(id + ":" + kind); await admin.from("google_sync_map").delete().eq("card_id", id).eq("kind", kind); };
  const drop = async (id: string) => { dropQ.add(id); cardQ.delete(id); cards.delete(id); changed++; };

  for (const { board } of accs || []) {
    const tok = await accessToken(userId, board); if (!tok) { report.push({ board, error: "Couldn't sign in to Google. Reconnect this area." }); continue; }
    const rep: any = { board, lists: [] }; report.push(rep);

    const events = await listAll(tok, `${CAL}?singleEvents=true&showDeleted=true&maxResults=2500&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}`, "items");
    rep.events = events ? events.filter((e: any) => e.status !== "cancelled").length : "failed";
    for (const e of events || []) {
      const m = byGoogle.get(board + ":e:" + e.id) || byGoogle.get(board + ":d:" + e.id);
      const gone = e.status === "cancelled";
      if (m && !m.card_id.startsWith("gc-")) {
        // One of Orbit's own items, changed or deleted in Google.
        const doc = cards.get(m.card_id); if (!doc) continue;
        if (m.kind === "due") {
          if (gone) { await unmap(m.card_id, "due"); save(m.card_id, { ...doc, due: null }); continue; }
          const day = e.start?.date; if (day && day !== doc.due) await put(m.card_id, { ...doc, due: day }, "due", e.id);
          continue;
        }
        if (gone) { await unmap(m.card_id, "event"); save(m.card_id, { ...doc, time: null, endTime: null, day: null }); continue; }
        const f = fromEvent(e), title = strip(e.summary);
        const end = doc.time ? (doc.endTime && doc.endTime > doc.time ? doc.endTime : plusHour(doc.time)) : null;
        if (f.time && (f.day !== doc.day || f.time !== doc.time || f.endTime !== end || title !== doc.title)) await put(m.card_id, { ...doc, day: f.day, time: f.time, endTime: f.endTime, title }, "event", e.id);
        continue;
      }
      if (e.id.startsWith(ORBIT_PREFIX)) continue;
      const id = `gc-${board}-${e.id}`, doc = cards.get(id);
      // Working location ("Office", "Home") is a Google status marker, not something to do.
      if (gone || e.eventType === "workingLocation") { if (doc) await drop(id); continue; }
      if (!e.start) continue;
      const f = fromEvent(e);
      const next: Doc = { ...(doc || { col: "next", order: 0, urgent: false, important: false, due: null, checklist: [], created: new Date().toISOString() }), src: "gcal", board, title: e.summary || "(No title)", note: e.description || "", guests: guestsOf(e), meet: meetOf(e), ...f } as Doc;
      if (!doc || (doc.meet || null) !== next.meet || JSON.stringify(wanted(next).event?.hash) !== JSON.stringify(wanted(doc).event?.hash)) await put(id, next, "event", e.id);
    }

    // Every list (Google Calendar shows them all): every open task however old, plus anything completed or deleted lately.
    const found = await listAll(tok, `${LISTS}/users/@me/lists?maxResults=100`, "items");
    // The default list comes first in Google's list order; ask for it by name too in case that ever changes.
    const defId = (await (await g(tok, "GET", `${LISTS}/users/@me/lists/@default`)).json().catch(() => ({})))?.id || found?.[0]?.id;
    const lists = found?.length ? found : [{ id: defId }];
    const tasks: any[] = [];
    for (const l of lists) {
      const base = l.id === defId || !l.id ? TASKS : `${LISTS}/lists/${l.id}/tasks`;
      const open = await listAll(tok, `${base}?showCompleted=false&showAssigned=true&maxResults=100`, "items");
      const recent = await listAll(tok, `${base}?showCompleted=true&showHidden=true&showDeleted=true&showAssigned=true&maxResults=100&updatedMin=${encodeURIComponent(new Date(now.getTime() - 60 * 864e5).toISOString())}`, "items");
      rep.lists.push({ name: l.title || "Tasks", open: open ? open.length : "failed", titles: (open || []).map((t: any) => t.title).filter(Boolean).slice(0, 60) });
      for (const t of new Map([...(open || []), ...(recent || [])].map(t => [t.id, t])).values()) tasks.push({ ...t, gid: base === TASKS ? t.id : `${l.id}~${t.id}` });
    }
    for (const t of tasks) {
      const m = byGoogle.get(board + ":t:" + t.gid);
      const gone = !!t.deleted, done = t.status === "completed", day = t.due ? String(t.due).slice(0, 10) : null;
      if (m && !m.card_id.startsWith("gt-")) {
        const doc = cards.get(m.card_id); if (!doc) continue;
        if (gone) { await unmap(m.card_id, "task"); save(m.card_id, { ...doc, day: null }); continue; }
        const next = { ...doc };
        if (done && doc.col !== "done") { next.prevCol = doc.col; next.col = "done"; next.doneAt = new Date().toISOString(); }
        if (!done && doc.col === "done") { next.col = doc.prevCol && doc.prevCol !== "done" ? doc.prevCol : "next"; delete next.doneAt; }
        if (day && day !== doc.day) next.day = day;
        if (t.title && strip(t.title) !== doc.title) next.title = strip(t.title);
        if (JSON.stringify(next) !== JSON.stringify(doc)) await put(m.card_id, next, "task", t.gid);
        continue;
      }
      const id = `gt-${board}-${t.gid}`, doc = cards.get(id);
      if (gone || (!doc && (done || !t.title))) { if (gone && doc) await drop(id); continue; }
      const next: Doc = { ...(doc || { col: "inbox", order: -Date.now() / 1e6, urgent: false, important: false, due: null, checklist: [], created: new Date().toISOString() }), src: "gtask", board, title: t.title, note: t.notes || "", day } as Doc;
      if (done && next.col !== "done") { next.prevCol = next.col; next.col = "done"; next.doneAt = new Date().toISOString(); }
      if (!done && next.col === "done") { next.col = next.prevCol && next.prevCol !== "done" ? next.prevCol : "inbox"; delete next.doneAt; }
      if (JSON.stringify(next) !== JSON.stringify(doc)) await put(id, next, "task", t.gid);
    }
  }
  const chunks = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / 500) }, (_, i) => a.slice(i * 500, i * 500 + 500));
  for (const c of chunks([...mapQ.values()])) { const { error } = await admin.from("google_sync_map").upsert(c); if (error) throw error; }
  for (const c of chunks([...cardQ.values()])) { const { error } = await admin.from("cards").upsert(c); if (error) throw error; }
  for (const c of chunks([...dropQ])) { await admin.from("google_sync_map").delete().in("card_id", c); await admin.from("cards").delete().in("id", c); }
  return { changed, report, version: 3 }; // bump with the app's SYNC_VERSION when the pull adds something the app needs
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  if (body.action === "pull") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return new Response(JSON.stringify({ error: "not signed in" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const out = await pull(user.id).catch(e => { console.error("pull error", e); return { changed: -1, error: String(e?.message || e) }; });
    return new Response(JSON.stringify(out), { headers: { ...cors, "Content-Type": "application/json" } });
  }
  const ids: string[] = body.ids || (body.id ? [body.id] : []);
  for (const id of ids.slice(0, 500)) { try { await syncCard(String(id)); } catch (e) { console.error("sync error", id, e); } }
  return new Response(JSON.stringify({ synced: ids.length }), { headers: { "Content-Type": "application/json" } });
});
