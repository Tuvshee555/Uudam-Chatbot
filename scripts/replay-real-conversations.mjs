#!/usr/bin/env node
/**
 * Real customer conversation replay QA.
 *
 * Pulls real Messenger/Instagram conversation threads from Neon, replays up to
 * LIMIT customer text turns through the local /api/demo endpoint, and scores:
 *   - answer safety
 *   - trip match
 *   - price/date consistency
 *   - photo/media correctness
 *   - silence/handoff behavior
 *
 * Reports are written to tmp/ (gitignored) because they can contain customer
 * text. Sender IDs are masked in console and report rows.
 *
 * Usage:
 *   npm run dev
 *   LIMIT=100 node scripts/replay-real-conversations.mjs
 *
 * Optional env:
 *   DEMO_URL=http://localhost:3004/api/demo
 *   SENDER_ID=<one sender id>
 *   LIMIT=100
 *   MAX_TURNS_PER_SENDER=20
 */

import { Client } from "pg";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadEnvFile(fileName) {
  const path = join(ROOT, fileName);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_0-9]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const DEMO_URL = process.env.DEMO_URL || "http://localhost:3004/api/demo";
const SENDER_FILTER = process.env.SENDER_ID || null;
const LIMIT = Math.max(1, Number(process.env.LIMIT || 100));
const MAX_TURNS_PER_SENDER = Math.max(1, Number(process.env.MAX_TURNS_PER_SENDER || 20));
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

const RED_FLAGS = [
  { field: "answer", label: "raw REFER leaked", pattern: /\bREFER\b/ },
  { field: "answer", label: "raw SILENT leaked", pattern: /\bSILENT\b/ },
  { field: "answer", label: "internal sentinel leaked", pattern: /NEEDS_MANUAL_FIX|source_description|travel_trip_entries|database/i },
  { field: "answer", label: "wrong staff title", pattern: /хүний нөөцийн менежер/i },
  { field: "answer", label: "apology/no-data lead killer", pattern: /уучлаарай|мэдээлэл алга|олдсонгүй|байхгүй байна/i },
];

const MEDIA_RE = /зураг|зург|photo|image|poster|постер|pdf|хөтөлбөр|program/i;
const PHOTO_RE = /зураг|зург|photo|image|poster|постер/i;
const PRICE_RE = /үнэ|хэд|төлбөр|нийт|сая|₮|mnt|унэ|une/i;
const DATE_RE = /\b\d{1,2}\s*(?:сар|\/|\.)\s*\d{1,2}\b|маргааш|өнөөдөр|энэ сар|дараа сар|next month|august|july|сарын/i;
const HANDOFF_RE = /зөвлөх|оператор|холбож|хүнтэй|менежер|хариу бич/i;
const CLARIFICATION_RE = /аль|сонго|тодруул|хэд хэдэн сонголт|хэд хэдэн аялал|2-3 өөр хувилбар/i;

function maskId(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function normalize(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length >= 3 && !["аялал", "аяллын", "үнэ", "хэд", "байна", "шууд", "нислэгтэй"].includes(t));
}

function includesLoose(haystack, needle) {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!h || !n) return false;
  return h.includes(n) || n.includes(h);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return [];
  const raw = String(Math.round(value));
  return [raw, raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",")];
}

function tripSearchText(trip) {
  const extra = trip.extra || {};
  const aliases = Array.isArray(extra.aliases) ? extra.aliases.join(" ") : "";
  return [trip.route_name, trip.category, trip.operator_name, aliases].filter(Boolean).join(" ");
}

function rankTripCandidates(message, trips) {
  const qTokens = tokens(message);
  if (qTokens.length === 0) return [];
  return trips
    .map((trip) => {
      const search = normalize(tripSearchText(trip));
      let score = 0;
      for (const token of qTokens) {
        if (search.includes(token)) score += token.length >= 6 ? 3 : 1;
      }
      if (includesLoose(search, message)) score += 12;
      return { trip, score };
    })
    .filter((row) => row.score >= 3)
    .sort((a, b) => b.score - a.score);
}

function expectedTrip(message, trips) {
  const ranked = rankTripCandidates(message, trips);
  if (ranked.length === 0) return { status: "unknown", trip: null, candidates: [] };
  const [first, second] = ranked;
  if (second && first.score - second.score < 3) {
    return { status: "ambiguous", trip: null, candidates: ranked.slice(0, 3).map((r) => r.trip) };
  }
  return { status: "matched", trip: first.trip, candidates: ranked.slice(0, 3).map((r) => r.trip) };
}

function replyMentionsTrip(reply, trip) {
  if (!trip) return false;
  const replyNorm = normalize(reply);
  const routeTokens = tokens(trip.route_name).filter((t) => t.length >= 4);
  const hits = routeTokens.filter((t) => replyNorm.includes(t)).length;
  return hits >= Math.min(2, routeTokens.length) || includesLoose(reply, trip.route_name);
}

function replyMentionsTripPriceOrDate(reply, trip) {
  const checks = [];
  for (const value of formatMoney(trip.adult_price)) checks.push(value);
  for (const value of formatMoney(trip.child_price)) checks.push(value);
  for (const date of trip.departure_dates || []) checks.push(date);
  return checks.some((part) => part && reply.includes(part));
}

function isClarificationReply(reply) {
  return CLARIFICATION_RE.test(reply);
}

function classifyTurn(row, result, trips) {
  const text = String(row.text || "");
  const reply = String(result.reply || "");
  const mediaUrls = result.mediaUrls || [];
  const isSilent = !reply.trim();
  const hasAttachments = row.attachments.length > 0;
  const wantsMedia = MEDIA_RE.test(text);
  const wantsPhoto = PHOTO_RE.test(text);
  const wantsPriceOrDate = PRICE_RE.test(text) || DATE_RE.test(text);
  const wantsHandoff = HANDOFF_RE.test(text);
  const expected = expectedTrip(text, trips);
  const issues = [];
  const ratings = {
    answer: "pass",
    trip: "n/a",
    priceDate: "n/a",
    photo: "n/a",
    silence: "pass",
  };

  for (const flag of RED_FLAGS) {
    if (flag.pattern.test(reply)) {
      if (flag.field === "encoding") ratings.answer = ratings.answer === "fail" ? "fail" : "review";
      else ratings[flag.field] = "fail";
      issues.push(flag.label);
    }
  }

  if (isSilent) {
    ratings.answer = wantsHandoff || expected.status === "unknown" || hasAttachments ? "pass" : "review";
    ratings.silence = wantsHandoff || expected.status === "unknown" || hasAttachments ? "pass" : "review";
  } else if (wantsHandoff && !/зөвлөх|холбож|хариу/i.test(reply)) {
    ratings.silence = "review";
    issues.push("handoff request received non-handoff answer");
  }

  if (expected.status === "matched") {
    const mentionsExpectedTrip = replyMentionsTrip(reply, expected.trip);
    ratings.trip = mentionsExpectedTrip || isSilent ? "pass" : isClarificationReply(reply) ? "review" : "fail";
    if (ratings.trip === "review") issues.push(`clarified instead of selecting expected trip: ${expected.trip.route_name}`);
    if (ratings.trip === "fail") issues.push(`reply does not mention expected trip: ${expected.trip.route_name}`);
  } else if (expected.status === "ambiguous") {
    ratings.trip = isClarificationReply(reply) || isSilent ? "pass" : "review";
    if (ratings.trip === "review") issues.push("ambiguous trip query did not clearly clarify");
  }

  if (wantsPriceOrDate && expected.status === "matched" && !isSilent) {
    ratings.priceDate = replyMentionsTripPriceOrDate(reply, expected.trip) ? "pass" : "review";
    if (ratings.priceDate === "review") issues.push("price/date ask did not include known price/date markers");
  }

  if (wantsPhoto) {
    if (expected.status === "matched") {
      const expectedPhotos = expected.trip.photo_urls || [];
      if (expectedPhotos.length === 0) {
        ratings.photo = mediaUrls.length === 0 ? "pass" : "fail";
        if (ratings.photo === "fail") issues.push("photo-less trip received media");
      } else {
        const allowed = new Set(expectedPhotos);
        const allFromTrip = mediaUrls.length > 0 && mediaUrls.every((url) => allowed.has(url));
        ratings.photo = allFromTrip ? "pass" : "fail";
        if (ratings.photo === "fail") issues.push("photo request did not return only this trip's photo URLs");
      }
    } else {
      ratings.photo = mediaUrls.length === 0 ? "pass" : "review";
      if (ratings.photo === "review") issues.push("media sent for ambiguous/unknown photo request");
    }
  } else if (mediaUrls.length > 0) {
    ratings.photo = "fail";
    issues.push("unsolicited photo media");
  }

  const score = Object.values(ratings).reduce((sum, value) => {
    if (value === "pass" || value === "n/a") return sum + 1;
    if (value === "review") return sum + 0.5;
    return sum;
  }, 0);

  return {
    ratings,
    score: Math.round((score / Object.keys(ratings).length) * 100),
    issues,
    expectedTripStatus: expected.status,
    expectedTripName: expected.trip?.route_name || "",
    candidateTrips: expected.candidates.map((t) => t.route_name),
  };
}

function preview(text, n = 220) {
  return String(text || "").replace(/\s+/g, " ").slice(0, n);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function ask(text, conversationId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(DEMO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-uudam-demo-qa": "1",
      },
      body: JSON.stringify({ text, conversationId }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    const json = JSON.parse(bodyText);
    return {
      reply: typeof json.reply === "string" ? json.reply : "",
      mediaUrls: Array.isArray(json.mediaUrls) ? json.mediaUrls.filter((url) => typeof url === "string") : [],
      brochureUrl: typeof json.brochureUrl === "string" ? json.brochureUrl : "",
      buttons: Array.isArray(json.buttons) ? json.buttons : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTrips(client) {
  const result = await client.query(`
    SELECT id, category, operator_name, route_name, adult_price, child_price,
           departure_dates, photo_urls, status, extra
    FROM travel_trip_entries
    WHERE status = 'active'
    ORDER BY updated_at DESC
  `);
  return result.rows.map((row) => ({
    ...row,
    adult_price: row.adult_price == null ? null : Number(row.adult_price),
    child_price: row.child_price == null ? null : Number(row.child_price),
    departure_dates: Array.isArray(row.departure_dates) ? row.departure_dates : [],
    photo_urls: parseJsonArray(row.photo_urls).filter((url) => url.startsWith("https://")),
    extra: parseJsonObject(row.extra),
  }));
}

async function fetchRealSenders(client) {
  if (SENDER_FILTER) return [SENDER_FILTER];
  const result = await client.query(
    `SELECT sender_id, MAX(created_at) AS last_seen, COUNT(*) AS n
     FROM travel_conversations
     WHERE sender_id ~ '^[0-9]+$'
     GROUP BY sender_id
     ORDER BY last_seen DESC
     LIMIT $1`,
    [LIMIT],
  );
  return result.rows.map((r) => r.sender_id);
}

async function fetchSenderHistory(client, senderId) {
  const result = await client.query(
    `SELECT role, text, attachments, created_at
     FROM travel_conversations
     WHERE sender_id = $1
     ORDER BY id ASC
     LIMIT $2`,
    [senderId, MAX_TURNS_PER_SENDER * 3],
  );
  return result.rows.map((row) => ({
    ...row,
    text: String(row.text || ""),
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }));
}

function makeConversationId(senderId) {
  return `replay-${maskId(senderId)}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80).padEnd(16, "0");
}

async function main() {
  const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("NEON_DATABASE_URL or DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const trips = await fetchTrips(client);
  const senders = await fetchRealSenders(client);
  const rows = [];
  const summary = {
    runId: RUN_ID,
    demoUrl: DEMO_URL,
    senderCount: senders.length,
    activeTrips: trips.length,
    textTurns: 0,
    attachmentTurns: 0,
    pass: 0,
    review: 0,
    fail: 0,
  };

  console.log(`Real replay QA -> ${DEMO_URL}`);
  console.log(`${senders.length} sender thread(s), ${trips.length} active trips.\n`);

  for (const senderId of senders) {
    const history = await fetchSenderHistory(client, senderId);
    const conversationId = makeConversationId(senderId);
    let userTurnCount = 0;
    console.log(`SENDER ${maskId(senderId)} (${history.length} stored rows)`);

    for (const row of history) {
      if (row.role !== "user") continue;
      if (userTurnCount >= MAX_TURNS_PER_SENDER) break;
      const hasText = row.text.trim() && !/^\[.*зураг.*\]$/i.test(row.text.trim());
      if (row.attachments.length > 0) summary.attachmentTurns += 1;
      if (!hasText) {
        rows.push({
          sender: maskId(senderId),
          createdAt: row.created_at,
          userText: "",
          attachmentCount: row.attachments.length,
          reply: "",
          mediaCount: 0,
          brochure: "",
          overall: "manual",
          score: 50,
          issues: ["attachment-only turn needs webhook/vision manual review"],
        });
        continue;
      }

      userTurnCount += 1;
      summary.textTurns += 1;
      try {
        const result = await ask(row.text, conversationId);
        const assessment = classifyTurn(row, result, trips);
        const overall = Object.values(assessment.ratings).includes("fail")
          ? "fail"
          : assessment.score < 90
            ? "review"
            : "pass";
        summary[overall] += 1;
        rows.push({
          sender: maskId(senderId),
          createdAt: row.created_at,
          userText: row.text,
          attachmentCount: row.attachments.length,
          reply: result.reply,
          mediaCount: result.mediaUrls.length,
          mediaUrls: result.mediaUrls,
          brochure: result.brochureUrl,
          buttons: result.buttons,
          overall,
          score: assessment.score,
          ...assessment,
        });
        const marker = overall === "pass" ? "ok  " : overall === "review" ? "REV " : "FAIL";
        console.log(`${marker} ${preview(row.text, 80)} -> ${preview(result.reply, 110)} media=${result.mediaUrls.length}`);
      } catch (error) {
        summary.fail += 1;
        rows.push({
          sender: maskId(senderId),
          createdAt: row.created_at,
          userText: row.text,
          attachmentCount: row.attachments.length,
          reply: "",
          mediaCount: 0,
          brochure: "",
          overall: "fail",
          score: 0,
          issues: [error instanceof Error ? error.message : String(error)],
        });
        console.log(`FAIL ${preview(row.text, 80)} -> request failed`);
      }
    }
  }

  await client.end();

  const outDir = join(ROOT, "tmp");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `real-conversation-replay-${RUN_ID}.json`);
  const csvPath = join(outDir, `real-conversation-replay-${RUN_ID}.csv`);
  writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2), "utf8");
  writeFileSync(
    csvPath,
    [
      ["sender", "createdAt", "overall", "score", "answer", "trip", "priceDate", "photo", "silence", "mediaCount", "expectedTrip", "issues", "userText", "reply"].join(","),
      ...rows.map((r) =>
        [
          r.sender,
          r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
          r.overall,
          r.score,
          r.ratings?.answer || "",
          r.ratings?.trip || "",
          r.ratings?.priceDate || "",
          r.ratings?.photo || "",
          r.ratings?.silence || "",
          r.mediaCount || 0,
          r.expectedTripName || "",
          (r.issues || []).join("; "),
          r.userText,
          r.reply,
        ].map(csvEscape).join(","),
      ),
    ].join("\n"),
    "utf8",
  );

  console.log("\nSummary");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report JSON: ${jsonPath}`);
  console.log(`Report CSV:  ${csvPath}`);
  console.log("Attachment-only turns are marked manual because /api/demo cannot replay uploaded images/PDFs.");

  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
