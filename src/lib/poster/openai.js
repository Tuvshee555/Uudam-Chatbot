// Reads a messy China travel doc (text) and returns clean, structured trip data.
// OpenAI Structured Outputs keeps the extractor schema-backed instead of free-form JSON.

export const DEFAULT_CONTACTS = {
  phones: ["7713 6633", "8913 6633", "9117 2769", "9924 8000"],
  email: "uudamtravel6@gmail.com",
  address: 'Чингэлтэй дүүрэг, 4-р хороо, Анхарагийн гудамж-23, "Todtower" офис, 701 тоот',
};

export const AGENCY = "UUDAM TRAVEL AGENCY";

export const TRIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "subtitle",
    "duration_days",
    "duration_nights",
    "flights",
    "departures",
    "price_table",
    "price_note",
    "days",
    "includes",
    "excludes",
  ],
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    duration_days: { type: "number" },
    duration_nights: { type: "number" },
    flights: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["outbound", "return"],
          properties: {
            outbound: { type: "string" },
            return: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    departures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date"],
        properties: {
          date: { type: "string" },
        },
      },
    },
    price_table: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["columns", "rows", "note"],
          properties: {
            columns: { type: "array", items: { type: "string" } },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["dates", "cells"],
                properties: {
                  dates: { type: "string" },
                  cells: { type: "array", items: { type: "string" } },
                },
              },
            },
            note: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    price_note: { type: "string" },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "day",
          "route",
          "distance_km",
          "summary",
          "activities",
          "meals",
          "hotel",
          "flight",
          "bonus",
          "photo",
          "photo_caption",
        ],
        properties: {
          day: { type: "number" },
          route: { type: "string" },
          distance_km: { type: "number" },
          summary: { type: "string" },
          activities: { type: "array", items: { type: "string" } },
          meals: {
            type: "object",
            additionalProperties: false,
            required: ["breakfast", "lunch", "dinner"],
            properties: {
              breakfast: { type: "boolean" },
              lunch: { type: "boolean" },
              dinner: { type: "boolean" },
            },
          },
          hotel: { type: ["string", "null"] },
          flight: { type: ["string", "null"] },
          bonus: { type: "array", items: { type: "string" } },
          photo: { type: ["string", "null"] },
          photo_caption: { type: "string" },
        },
      },
    },
    includes: { type: "array", items: { type: "string" } },
    excludes: { type: "array", items: { type: "string" } },
  },
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function modelCandidates() {
  return unique([process.env.OPENAI_MODEL, "gpt-5.5", "gpt-4.1", "gpt-4o"]);
}

// Vision-capable models, in order of preference (used for image/PDF visual extraction)
function visionModelCandidates() {
  return unique([process.env.OPENAI_VISION_MODEL, process.env.OPENAI_MODEL, "gpt-4.1", "gpt-4o"]);
}

const SYSTEM_PROMPT =
  "You extract travel documents into structured data. You are a DATA EXTRACTOR not a writer. NEVER write, generate, or invent any text. Only copy text that exists verbatim in the source document. If text is not in the source, use empty string. Translate Chinese to Mongolian only for route names and headers.";

// Used when the model can SEE the document (image or PDF page render). The visual layout
// is reliable here even when raw text extraction scrambles column order.
const VISION_USER_PROMPT = `Create structured data for a UUDAM Travel poster from this travel document.

READ THE DOCUMENT VISUALLY as it appears on the page. The day program section lists days as "DAY 1", "DAY 2", etc. Each day has a route title and a body paragraph that belongs DIRECTLY UNDER that day's heading on the page. Match each day's body text to the correct day by its visual position — do not guess.

Rules:
- Output Mongolian text for route/header fields only.
- For "summary": copy the program/хөтөлбөр paragraph for that day WORD FOR WORD exactly as written under that day on the page. Match it to the CORRECT day by visual position. Never put one day's text under another day. If a day genuinely has no body text on the page, use "". Process EVERY day including the very last one — do not skip the final day.
- For "activities": copy bullet points or sentences from the source exactly. Do not add, remove, or change any words. If none exist use [].
- Prices: copy the exact price text from the page (e.g. "1,390,000₮"). Do not reformat numbers.
- In price_table, columns must NOT include a date/огноо column — dates go in the "dates" field of each row only. Copy the date text EXACTLY as written on the page (e.g. "7 сарын 2, 8, 9, 16, 20, 23"). Do NOT convert to ISO/numeric format like 2026-07-02.
- Each row's cells array must match columns length exactly with the real price values. Do not leave cells empty.
- If a price has both yuan and tugrik, put both like "4,180 юань / 2,340,000₮".
- MEALS — read very carefully. To the RIGHT of each day's row there is a small vertical list of THREE meal lines in this fixed top-to-bottom order: Өглөөний цай (breakfast), Өдрийн хоол (lunch), Оройн хоол (dinner). Each line has a mark next to it: a GREEN CHECK (✓) = included → true, a RED CROSS / X (✗) = NOT included → false. These marks sit in a column aligned BY ROW to each day — read straight across from the day to its three marks, and do not shift up or down to a neighbouring day's marks. Set meals.breakfast / meals.lunch / meals.dinner exactly from the ✓/✗ for THAT day. If a day's row has NO marks at all (blank, like the last days sometimes are), set all three to false. Never assume a default — only use what the marks show.
- Use null for unknown flights/hotels/photos, not made-up data.
- Keep includes and excludes arrays empty unless the source clearly lists them.`;

// Fill in defaults + agency/contacts so every extractor returns a consistent shape.
export function normalizeExtractedTrip(trip) {
  trip.contacts = DEFAULT_CONTACTS;
  trip.agency = AGENCY;
  trip.departures ||= [];
  trip.days ||= [];
  trip.includes ||= [];
  trip.excludes ||= [];
  for (const [index, day] of trip.days.entries()) {
    day.day = Number(day.day || index + 1);
    day.summary ||= "";
    day.activities ||= [];
    day.bonus ||= [];
    day.meals ||= { breakfast: true, lunch: false, dinner: true };
    day.hotel ??= null;
    day.flight ??= null;
    day.photo = null;
    day.photo_caption ||= "";
  }
  return trip;
}

// Shared call for vision extraction — content is the user message content array
// (input_image / input_file + input_text). Tries each vision model in turn.
async function askVision(content) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY.");
  const errors = [];
  const models = visionModelCandidates();
  for (const model of models) {
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          max_output_tokens: 14000,
          input: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content },
          ],
          text: {
            format: { type: "json_schema", name: "trip_extraction", strict: true, schema: TRIP_SCHEMA },
          },
        }),
      });
      const body = await res.text();
      let data;
      try { data = JSON.parse(body); } catch { data = null; }
      if (!res.ok) throw new Error(`OpenAI ${model} error ${res.status}: ${data?.error?.message || body.slice(0, 300)}`);
      const output = getOutputText(data);
      if (!output) throw new Error(`OpenAI ${model} returned no text output`);
      return normalizeExtractedTrip(parseTripJson(output));
    } catch (error) {
      errors.push(error.message);
      const shouldTryNext =
        /model|not found|does not exist|unsupported|invalid|unrecognized|access/i.test(error.message) &&
        model !== models.at(-1);
      if (!shouldTryNext) break;
    }
  }
  throw new Error(errors.join(" | "));
}

function getOutputText(data) {
  if (data?.output_text) return data.output_text;

  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) return content.text;
      if (content?.text) return content.text;
    }
  }

  return "";
}

function extractJsonCandidate(text) {
  let cleaned = String(text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);

  return cleaned
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/}\s*(?={)/g, "},")
    .replace(/]\s*(?={)/g, "],")
    .trim();
}

function parseTripJson(text) {
  return JSON.parse(extractJsonCandidate(text));
}

async function askOpenAI(model, docText) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 14000,
      input: [
        {
          role: "system",
          content:
            "You extract travel documents into structured data. You are a DATA EXTRACTOR not a writer. NEVER write, generate, or invent any text. Only copy text that exists verbatim in the source document. If text is not in the source, use empty string. Translate Chinese to Mongolian only for route names and headers.",
        },
        {
          role: "user",
          content: `Create structured data for a UUDAM Travel poster from this document.

Rules:
- Output Mongolian text for route/header fields only.
- For "summary": copy ALL program/хөтөлбөр text for that day WORD FOR WORD from the source. Even one sentence is fine — never leave it empty if the source has ANY text for that day. Only use "" if the source truly has zero text. DO NOT write a single word not in the source.
- For "activities": copy bullet points or sentences from the source exactly. Do not add, remove, or change any words. If none exist use [].
- In price_table, extract every price column you can find (e.g. "Том хүн", "15 насаас доош", "1.2м доош", "0-2 настай").
- CRITICALLY: DO NOT leave cells empty. Each row's cells array must match columns length exactly with the actual price values.
- If a price has both yuan and tugrik (e.g. "4180 юань / 2,340,000₮"), put both in the cell like "4,180 юань / 2,340,000₮".
- The dates field per row should be the departure date(s) (e.g. "2026-07-04").
- columns must NOT include a date/огноо column — dates go in the "dates" field only.
- Infer meals from the document. If unclear, breakfast is usually included after day 1, lunch is often not included, dinner is included only when stated or likely from the program.
- Use null for unknown flights/hotels/photos, not made-up data.
- Keep includes and excludes arrays empty unless the source clearly lists them.

DOCUMENT:
${docText}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "trip_extraction",
          strict: true,
          schema: TRIP_SCHEMA,
        },
      },
    }),
  });

  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error?.message || body.slice(0, 500);
    throw new Error(`OpenAI ${model} error ${res.status}: ${message}`);
  }

  const output = getOutputText(data);
  if (!output) throw new Error(`OpenAI ${model} returned no text output`);
  return output;
}

async function extractWithFallback(docText) {
  const errors = [];

  for (const model of modelCandidates()) {
    try {
      const output = await askOpenAI(model, docText);
      return parseTripJson(output);
    } catch (error) {
      errors.push(error.message);
      const shouldTryNext =
        /model|not found|does not exist|unsupported|invalid|unrecognized|access/i.test(error.message) &&
        model !== modelCandidates().at(-1);
      if (!shouldTryNext) break;
    }
  }

  throw new Error(errors.join(" | "));
}

export async function extractTripFromImage(base64, mimeType) {
  return askVision([
    { type: "input_image", image_url: `data:${mimeType};base64,${base64}` },
    { type: "input_text", text: VISION_USER_PROMPT },
  ]);
}

// Send the PDF file directly to the model. It renders the PDF internally and reads it
// VISUALLY, so day text is matched by its position on the page — this avoids the
// scrambled-column problem that plain text extraction suffers from on multi-column PDFs.
export async function extractTripFromPdf(base64, filename = "document.pdf") {
  return askVision([
    {
      type: "input_file",
      filename,
      file_data: `data:application/pdf;base64,${base64}`,
    },
    { type: "input_text", text: VISION_USER_PROMPT },
  ]);
}

export async function extractTrip(docText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env.local or your deployment environment.");
  }

  return normalizeExtractedTrip(await extractWithFallback(docText));
}

// After the main extraction, send the PDF + the extracted day summaries back to the model.
// It checks each day's summary against what it visually sees on the page and corrects swaps.
const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["days"],
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "summary"],
        properties: {
          day: { type: "number" },
          summary: { type: "string" },
        },
      },
    },
  },
};

export async function verifyDaySummaries(trip, pdfBase64, pdfFilename) {
  if (!process.env.OPENAI_API_KEY) return trip;
  const dayList = trip.days.map((d) => `DAY ${d.day}: ${d.summary}`).join("\n\n");
  const prompt = `Below is extracted day-by-day summary text from this PDF poster document. Some summaries may have been placed under the wrong day (swapped). Your job: look at the PDF visually, find the body paragraph that appears DIRECTLY UNDER each day heading (DAY 1, DAY 2, …) on the page, and return the correct summary for EVERY day.

RULES:
- Copy the body text EXACTLY word for word from the PDF. Do NOT paraphrase, translate, or add anything.
- If the extracted text for a day is ALREADY correct, return it unchanged.
- If a day's text is swapped with another, put each back under the correct day.
- If a day genuinely has no body text on the page, return "".
- Return ALL ${trip.days.length} days — do not skip any.

EXTRACTED (may have swaps):
${dayList}`;

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: visionModelCandidates()[0],
        max_output_tokens: 8000,
        input: [
          {
            role: "system",
            content:
              "You are a fact-checker for travel document extraction. You verify that each day's extracted summary matches the text that appears visually under that day heading in the source PDF. Never invent or rewrite text.",
          },
          {
            role: "user",
            content: [
              { type: "input_file", filename: pdfFilename, file_data: `data:application/pdf;base64,${pdfBase64}` },
              { type: "input_text", text: prompt },
            ],
          },
        ],
        text: {
          format: { type: "json_schema", name: "day_verify", strict: true, schema: VERIFY_SCHEMA },
        },
      }),
    });

    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch { return trip; }
    if (!res.ok) { console.warn("verifyDaySummaries failed:", data?.error?.message); return trip; }

    const output = getOutputText(data);
    if (!output) return trip;

    let corrections;
    try { corrections = JSON.parse(extractJsonCandidate(output)); } catch { return trip; }

    const map = {};
    for (const c of corrections.days || []) map[c.day] = c.summary;
    for (const day of trip.days) {
      if (map[day.day] !== undefined) day.summary = map[day.day];
    }
  } catch (err) {
    console.warn("verifyDaySummaries error (non-fatal):", err.message);
  }

  return trip;
}
