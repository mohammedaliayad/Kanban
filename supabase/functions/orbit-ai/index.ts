// Orbit AI: turns a typed note ("dentist Tuesday 3pm, renew Iveco rego by the 30th, urgent") into
// ready-to-add Orbit tasks. Turn OFF "Verify JWT" for this function; it checks the signed-in user itself.
// Needs the ANTHROPIC_API_KEY secret.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });

const nullable = (t: string, extra: Record<string, unknown> = {}) => ({ type: [t, "null"], ...extra });
function schema(boards: string[], cols: string[]) {
  const task = {
    type: "object", additionalProperties: false,
    properties: {
      title: { type: "string", description: "Short task title, in the user's words" },
      board: { type: "string", enum: boards },
      col: { type: "string", enum: cols },
      day: nullable("string", { description: "YYYY-MM-DD the user plans to do it, or null" }),
      time: nullable("string", { description: "HH:MM 24h start time, or null for all-day" }),
      endTime: nullable("string", { description: "HH:MM 24h end time, or null" }),
      due: nullable("string", { description: "YYYY-MM-DD deadline, or null" }),
      urgent: { type: "boolean" },
      important: { type: "boolean" },
      repeat: { type: "string", enum: ["", "daily", "weekdays", "weekly", "monthly"] },
      checklist: { type: "array", items: { type: "string" } },
      guests: { type: "array", items: { type: "string" }, description: "Email addresses to invite" },
      note: { type: "string" },
    },
    required: ["title", "board", "col", "day", "time", "endTime", "due", "urgent", "important", "repeat", "checklist", "guests", "note"],
  };
  return {
    type: "object", additionalProperties: false,
    properties: { tasks: { type: "array", items: task }, reply: { type: "string", description: "One short sentence for the user about what you set up, or a question if something was unclear" } },
    required: ["tasks", "reply"],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "not signed in" }, 401);
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "").slice(0, 4000);
  if (!text.trim()) return json({ tasks: [], reply: "Type what you need to do." });
  const boards = (body.boards || []).map((b: { id: string; name: string; about?: string }) => b);
  const cols = (body.columns || []).map((c: { id: string; name: string }) => c);
  if (!boards.length || !cols.length) return json({ error: "missing boards" }, 400);

  const system = `You file tasks into Orbit Ai, a personal task and calendar app. Turn the user's note into tasks.
Today is ${body.today} (${body.weekday}), time zone Australia/Sydney. Resolve relative dates ("Tuesday", "next week", "the 30th") to real dates after today.
Areas (board): ${boards.map((b: { id: string; name: string; about?: string }) => `${b.id} = ${b.name}${b.about ? ` (${b.about})` : ""}`).join("; ")}. Pick the area the task belongs to; use ${body.defaultBoard || boards[0].id} if it's unclear.
Columns (col): ${cols.map((c: { id: string; name: string }) => `${c.id} = ${c.name}`).join("; ")}. Use the second column for normal tasks, the first for vague ideas.
"day" is when they'll do it; give a "time" only when they said one (meetings, appointments). A deadline ("by Friday", "due the 30th") goes in "due", not "day".
urgent = time-sensitive or they said urgent/asap; important = matters for their goals, money, family or the business. Default both to false.
Put sub-steps or a list of items in "checklist". Keep titles short and in the user's words. Never invent tasks they didn't mention.`;

  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: text }],
      output_config: { effort: "low", format: { type: "json_schema", schema: schema(boards.map((b: { id: string }) => b.id), cols.map((c: { id: string }) => c.id)) } },
    } as any);
    if (res.stop_reason === "refusal") return json({ tasks: [], reply: "I couldn't help with that one. Try rewording it." });
    const out = (res.content as any[]).filter(b => b.type === "text").map(b => b.text).join("");
    const parsed = JSON.parse(out);
    return json({ tasks: Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 50) : [], reply: String(parsed.reply || "") });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "The Anthropic API key isn't set up yet." }, 500);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Too many requests. Try again in a moment." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `AI error ${e.status}` }, 502);
    console.error("orbit-ai", e);
    return json({ error: "Couldn't read the AI's answer. Try again." }, 500);
  }
});
