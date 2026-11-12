import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveToken } from "@/lib/view";

export const dynamic = "force-dynamic";

// AG Grid AI Toolkit bridge: grid schema (getStructuredSchema) + current state + request -> Claude
// structured output -> validated on the client -> api.setState(). Only changes the VIEW, never data.
// Requires a valid case token and is rate-limited so the endpoint can't be used as an open proxy.
const hits = new Map<string, number[]>();
function limited(key: string, max = 20, windowMs = 10 * 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
function normType(t: unknown): unknown {
  const arr = (Array.isArray(t) ? t : [t]).map((x) => (TYPES.has(String(x)) ? String(x) : "string"));
  const uniq = [...new Set(arr)];
  return uniq.length === 1 ? uniq[0] : uniq;
}

const DROP = new Set(["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "$schema"]);
/** Normalises AG Grid's structured schema to JSON Schema draft-07, which Claude validates. */
function clean(schema: unknown, depth = 0): unknown {
  if (depth > 20 || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP.has(k)) continue;
    if (k === "properties" || k === "$defs" || k === "definitions") {
      // name -> sub-schema map (property names like "type" are NOT keywords here)
      const m: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries((v ?? {}) as Record<string, unknown>)) m[name] = clean(sub, depth + 1);
      out[k === "$defs" ? "definitions" : k] = m; // AG Grid emits 2019-09 "$defs"
    } else if (k === "items" || k === "additionalProperties" || k === "not") {
      out[k] = typeof v === "object" ? clean(v, depth + 1) : v;
    } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      out[k] = Array.isArray(v) ? v.map((x) => clean(x, depth + 1)) : v;
    } else if (k === "$ref" && typeof v === "string") out.$ref = v.replace("#/$defs/", "#/definitions/");
    else if (k === "enum" && Array.isArray(v)) out.enum = [...new Set(v.map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
    else if (k === "type" && (typeof v === "string" || Array.isArray(v))) out.type = normType(v);
    else out[k] = v;
  }
  if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; schema?: unknown; state?: unknown; query?: string };
  const who = body.token ? await resolveToken(String(body.token)) : null;
  if (!who) return NextResponse.json({ error: "invalid link" }, { status: 403 });
  if (limited(who.caseId)) return NextResponse.json({ error: "too many requests" }, { status: 429 });
  const schemaText = JSON.stringify(body.schema ?? {});
  if (schemaText.length > 60_000) return NextResponse.json({ error: "schema too large" }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  if (process.env.GRID_AI_DEBUG) (await import("node:fs")).writeFileSync(process.env.GRID_AI_DEBUG, JSON.stringify(clean(body.schema), null, 1));
  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: process.env.AGENT_MODEL ?? "claude-sonnet-5-5",
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: clean(body.schema) as Record<string, unknown> } },
      messages: [
        {
          role: "user",
          content: `You control the view of a data grid that compares a client's tax return with their papers. Translate the user's request (any language) into AG Grid state using the schema.
- To show only items that do NOT match, set a filter on column "status" with the values CLARIFY, DIFFERENT and NOCHECK (exclude MATCH).
- To show one group (family, earnings, credits, refund, preparer), filter column "section" with the matching value(s) from the schema.
- To find an item by name, use a text "contains" filter on "conceptText".
- For amount conditions ("over 2000", "less than $500", "mais de 2 mil"), use a number filter on column "amount" (greaterThan / lessThan / inRange).
- Never return null for every property: return the concrete state needed.
Current grid state:\n${JSON.stringify(body.state).slice(0, 6000)}\n\nUser request: "${String(body.query ?? "").slice(0, 300)}"`,
        },
      ],
    });
    if (msg.stop_reason === "refusal") return NextResponse.json({ error: "refused" }, { status: 422 });
    if (msg.stop_reason === "max_tokens") return NextResponse.json({ error: "request too complex" }, { status: 422 });
    const text = msg.content.find((b) => b.type === "text");
    return NextResponse.json({ result: text && "text" in text ? JSON.parse(text.text) : null });
  } catch (e) {
    console.error("grid-ai", String(e).slice(0, 300));
    return NextResponse.json({ error: "AI unavailable" }, { status: 500 });
  }
}
