// Gemini-based PDF/image extractor for UUDAM travel posters.
// Gemini 2.5 Flash accepts inline PDF bytes natively, reads multi-column layouts
// correctly, and is fast enough to stay within Vercel's 60s function limit.

import { DEFAULT_CONTACTS, AGENCY, TRIP_SCHEMA, normalizeExtractedTrip } from "./openai.js";

// Gemini /v1beta generateContent endpoint with structured JSON output
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function geminiModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

const SYSTEM_INSTRUCTION = `You extract travel documents into structured data. You are a DATA EXTRACTOR not a writer. NEVER write, generate, or invent any text. Only copy text that exists verbatim in the source document. If text is not in the source, use empty string. Translate Chinese to Mongolian only for route names and headers.`;

const USER_PROMPT = `Create structured data for a UUDAM Travel poster from this travel document.

READ THE DOCUMENT VISUALLY as it appears on the page. The day program section lists days as "DAY 1", "DAY 2", etc. Each day has a route title and a body paragraph that belongs DIRECTLY UNDER that day's heading on the page. Match each day's body text to the correct day by its visual position — do not guess or swap.

CRITICAL — day summary accuracy:
- For "summary": copy the body paragraph for that day WORD FOR WORD exactly as written DIRECTLY UNDER that day's heading on the page.
- Match by VISUAL POSITION: the text that sits below DAY 1 heading goes into day 1, the text below DAY 2 goes into day 2, etc. Never put day N's text into day N+1 or day N-1.
- If a day genuinely has no body text on the page, use "".
- Process EVERY day including the very last one — do not skip the final day.

OTHER RULES:
- Output Mongolian text for route/header fields only.
- For "activities": copy bullet points or sentences from the source exactly. Do not add, remove, or change any words. If none exist use [].
- Prices: copy the exact price text from the page (e.g. "1,390,000₮"). Do not reformat numbers.
- In price_table, columns must NOT include a date/огноо column — dates go in the "dates" field of each row only.
- Copy date text EXACTLY as written on the page (e.g. "7 сарын 2, 8, 9, 16, 20, 23"). Do NOT convert to ISO format like 2026-07-02.
- Each row's cells array must match columns length exactly with real price values. Do not leave cells empty.
- If a price has both yuan and tugrik, put both like "4,180 юань / 2,340,000₮".
- MEALS: To the RIGHT of each day's row there is a small vertical list of THREE meal lines (top to bottom: breakfast, lunch, dinner). Each has a GREEN CHECK (✓) = true or RED CROSS (✗) = false. Read straight across from each day to its marks. If a day has no marks at all, set all three to false.
- Use null for unknown flights/hotels/photos.
- Keep includes and excludes arrays empty unless clearly listed.`;

// Convert OpenAI JSON Schema to Gemini response_schema (Gemini uses a subset)
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      out.type = nonNull[0].toUpperCase();
      out.nullable = schema.type.includes("null");
    }
  } else if (schema.type) {
    out.type = schema.type.toUpperCase();
  }
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  // anyOf with one null option → make nullable
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter((s) => s.type !== "null");
    const hasNull = schema.anyOf.some((s) => s.type === "null");
    if (nonNull.length === 1) {
      Object.assign(out, toGeminiSchema(nonNull[0]));
      if (hasNull) out.nullable = true;
    }
    delete out.type; // type was set above if anyOf present
    if (nonNull.length === 1 && nonNull[0].type) out.type = nonNull[0].type.toUpperCase();
  }
  return out;
}

// Bounded so a hung Gemini call fails fast instead of silently eating the
// whole 60s serverless budget (which would get the function killed by Vercel
// mid-request with no response — the endless-spinner failure mode). Real
// extractions measure 5-25s; 35s leaves the OpenAI fallback a fighting chance.
const GEMINI_FETCH_TIMEOUT_MS = Number(process.env.GEMINI_PDF_FETCH_TIMEOUT_MS || 35_000);

export async function extractTripFromPdfGemini(base64, filename = "document.pdf") {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");

  const model = geminiModel();
  const geminiSchema = toGeminiSchema(TRIP_SCHEMA);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${GEMINI_URL(model)}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: "application/pdf", data: base64 } },
              { text: USER_PROMPT },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: geminiSchema,
          max_output_tokens: 16000,
        },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError" || /abort/i.test(String(error?.message || error))) {
      throw new Error(`Gemini request exceeded ${Math.round(GEMINI_FETCH_TIMEOUT_MS / 1000)}s timeout`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`Gemini non-JSON response: ${body.slice(0, 300)}`); }

  if (!res.ok) {
    const msg = data?.error?.message || body.slice(0, 400);
    throw new Error(`Gemini ${model} error ${res.status}: ${msg}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini ${model} returned no text output`);

  let trip;
  try {
    trip = JSON.parse(text);
  } catch {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    trip = JSON.parse(cleaned);
  }

  return normalizeExtractedTrip(trip);
}
