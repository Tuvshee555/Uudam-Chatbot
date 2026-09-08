#!/usr/bin/env node
import pg from "pg";
import { PDFDocument } from "pdf-lib";

const DEMO_URL = process.env.DEMO_URL || "http://localhost:3004/api/demo";
const RUN_ID = Date.now().toString(36);
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

type TripRow = {
  id: string;
  route_name: string;
  adult_price: number | null;
  child_price: number | null;
  status: string;
  photo_count: number;
  poster_id: string | null;
  departure_count: number;
};

type DemoResult = {
  reply: string;
  mediaUrls: string[];
  brochureUrl: string | null;
};

const redFlags = [
  { label: "raw REFER leaked", pattern: /\bREFER\b/ },
  { label: "raw SILENT leaked", pattern: /\bSILENT\b/ },
  { label: "internal field leaked", pattern: /NEEDS_MANUAL_FIX|source_description|travel_trip_entries|database/i },
  { label: "wrong staff title", pattern: /хүний нөөцийн менежер/i },
  { label: "repeat scold", pattern: /өмнө нь хэлсэн|as I mentioned|already told/i },
  { label: "dead Cloudinary raw PDF", pattern: /res\.cloudinary\.com\/[^/]+\/raw\/upload\/.+\.pdf/i },
];

function conversationId(label: string) {
  return `current-${RUN_ID}-${label}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80).padEnd(16, "0");
}

async function ask(text: string, id: string): Promise<DemoResult> {
  const res = await fetch(DEMO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-uudam-demo-qa": "1",
    },
    body: JSON.stringify({ text, conversationId: id }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  return {
    reply: typeof json.reply === "string" ? json.reply : "",
    mediaUrls: Array.isArray(json.mediaUrls) ? json.mediaUrls.filter((url: unknown): url is string => typeof url === "string") : [],
    brochureUrl: typeof json.brochureUrl === "string" ? json.brochureUrl : null,
  };
}

function digits(value: number | null) {
  return typeof value === "number" ? String(value) : "";
}

function priceLooksPresent(reply: string, trip: TripRow) {
  const compact = reply.replace(/[,\s.]/g, "");
  return [digits(trip.adult_price), digits(trip.child_price)]
    .filter(Boolean)
    .some((price) => compact.includes(price));
}

function hasTripNameSignal(reply: string, trip: TripRow) {
  const firstToken = trip.route_name.split(/[\s,-]+/).find((token) => token.length >= 4);
  return Boolean(firstToken && reply.toLowerCase().includes(firstToken.toLowerCase()));
}

function includesAnyCaseInsensitive(reply: string, needles: string[]) {
  const lowerReply = reply.toLowerCase();
  return needles.some((needle) => lowerReply.includes(needle.toLowerCase()));
}

function checkCommon(reply: string) {
  return redFlags.filter((flag) => flag.pattern.test(reply)).map((flag) => flag.label);
}

async function verifyPdf(url: string, expectedPosterId: string) {
  if (!url.includes(`/api/poster-pdf?id=${encodeURIComponent(expectedPosterId)}`)) {
    return `wrong poster URL: expected ${expectedPosterId}, got ${url}`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) return `PDF fetch HTTP ${res.status}`;
  const type = res.headers.get("content-type") || "";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!type.includes("pdf")) return `PDF content-type wrong: ${type}`;
  if (bytes.length < 50_000) return `PDF too small: ${bytes.length} bytes`;
  const pdf = await PDFDocument.load(bytes);
  if (pdf.getPageCount() < 1) return "PDF has no pages";
  return null;
}

async function currentTrips(): Promise<TripRow[]> {
  const rows = (await pool.query(
    `SELECT
       id,
       route_name,
       adult_price,
       child_price,
       status,
       CASE WHEN jsonb_typeof(photo_urls) = 'array' THEN jsonb_array_length(photo_urls) ELSE 0 END::int AS photo_count,
       extra->>'poster_trip_id' AS poster_id,
       CASE
         WHEN jsonb_typeof(extra->'departure_dates_resolved') = 'array'
         THEN jsonb_array_length(extra->'departure_dates_resolved')
         ELSE cardinality(departure_dates)
       END::int AS departure_count
     FROM travel_trip_entries
     ORDER BY route_name`,
  )).rows;
  return rows;
}

async function run() {
  const trips = await currentTrips();
  const activeTrips = trips.filter((trip) => trip.status === "active");
  const archivedTrips = trips.filter((trip) => trip.status === "archived");
  const failures: string[] = [];
  let checks = 0;

  console.log(`Current-catalog demo QA -> ${DEMO_URL}`);
  console.log(`Trips loaded: ${trips.length}; active=${activeTrips.length}; archived=${archivedTrips.length}`);
  if (trips.length !== 22) failures.push(`expected 22 trips, got ${trips.length}`);
  if (activeTrips.length + archivedTrips.length !== 22) failures.push("active+archived count does not equal 22");

  for (const trip of activeTrips) {
    checks += 1;
    if (trip.photo_count <= 0) failures.push(`${trip.route_name}: no photos`);
    if (!trip.poster_id) failures.push(`${trip.route_name}: no poster link`);
    if (trip.departure_count <= 0) failures.push(`${trip.route_name}: no departure dates`);

    const exactInfo = await ask(`${trip.route_name} мэдээлэл авъя`, conversationId(`info-${trip.id}`));
    checks += 1;
    const infoProblems = checkCommon(exactInfo.reply);
    if (!exactInfo.reply.trim()) infoProblems.push("empty info reply");
    if (!hasTripNameSignal(exactInfo.reply, trip)) infoProblems.push("reply does not mention requested trip");
    if (infoProblems.length) failures.push(`${trip.route_name} info: ${infoProblems.join("; ")}`);

    const price = await ask(`${trip.route_name} үнэ хэд вэ`, conversationId(`price-${trip.id}`));
    checks += 1;
    const priceProblems = checkCommon(price.reply);
    if (!price.reply.trim()) priceProblems.push("empty price reply");
    if (trip.adult_price !== null && !priceLooksPresent(price.reply, trip)) {
      priceProblems.push(`price missing expected ${trip.adult_price}/${trip.child_price ?? ""}`);
    }
    if (priceProblems.length) failures.push(`${trip.route_name} price: ${priceProblems.join("; ")}`);

    const program = await ask(`${trip.route_name} хөтөлбөр pdf явуулаач`, conversationId(`pdf-${trip.id}`));
    checks += 1;
    const programProblems = checkCommon(program.reply);
    if (!program.brochureUrl) {
      programProblems.push("no brochureUrl");
    } else if (trip.poster_id) {
      const pdfProblem = await verifyPdf(program.brochureUrl, trip.poster_id);
      if (pdfProblem) programProblems.push(pdfProblem);
    }
    if (programProblems.length) failures.push(`${trip.route_name} PDF: ${programProblems.join("; ")}`);
    console.log(`ok route=${trip.route_name} photos=${trip.photo_count} dates=${trip.departure_count} pdf=${program.brochureUrl ? "yes" : "no"}`);
  }

  const oddQuestions = [
    { id: "shangai-latin", text: "bi shangai aylalin medeellel awya", expectAny: ["Шанхай", "Аль"] },
    { id: "beidaihe-latin", text: "beidaihe une", expectAny: ["Бэйдайхэ"] },
    { id: "hailaar-bad", text: "hailaariin ayalal medeelel", expectAny: ["Хайлаар", "Манжуур"] },
    { id: "ambiguous-shanghai", text: "Шанхай аялал", expectAny: ["Аль", "Шанхай"] },
    { id: "ambiguous-hailaar", text: "Хайлаар аялал", expectAny: ["Аль", "Хайлаар"] },
    { id: "unknown", text: "Токио аялал байна уу", expectAny: ["зөвлөх", "холбож"] },
    { id: "discount", text: "Хямдрал байгаа юу", expectAny: ["зөвлөх", "хямдрал", "одоогоор"] },
    { id: "date-price", text: "Шанхай 9 сарын 17 үнэ хэд вэ", expectAny: ["₮", "Шанхай"] },
    { id: "specific-date", text: "10 сарын 8-нд ямар аялал байна", expectAny: ["10 сарын 8"] },
    { id: "today", text: "өнөөдөр гарах аялал байна уу", expectAny: ["зөвлөх", "байхгүй", "одоогоор"] },
  ];

  for (const q of oddQuestions) {
    checks += 1;
    const result = await ask(q.text, conversationId(q.id));
    const problems = checkCommon(result.reply);
    if (!result.reply.trim()) problems.push("empty reply");
    if (!includesAnyCaseInsensitive(result.reply, q.expectAny)) {
      problems.push(`missing any of: ${q.expectAny.join(" | ")}`);
    }
    if (problems.length) failures.push(`${q.id}: ${problems.join("; ")} :: ${result.reply.replace(/\s+/g, " ").slice(0, 180)}`);
  }

  const bookingId = conversationId("booking-flow");
  const bookingTurns = [
    { text: "Бэйдайхэ газар нислэг хосолсон аялал захиалмаар байна", expectAny: ["дугаар", "утас", "зөвлөх", "Бэйдайхэ"] },
    { text: "99112233", expectAny: ["Баярлалаа", "99112233", "зөвлөх"] },
    { text: "төлбөр төлчихлөө баталгаажуул", expectAny: ["баталгаажуулж чадахгүй", "зөвлөх"] },
  ];
  for (const turn of bookingTurns) {
    checks += 1;
    const result = await ask(turn.text, bookingId);
    const problems = checkCommon(result.reply);
    if (!result.reply.trim()) problems.push("empty booking reply");
    if (!includesAnyCaseInsensitive(result.reply, turn.expectAny)) {
      problems.push(`missing any of: ${turn.expectAny.join(" | ")}`);
    }
    if (problems.length) failures.push(`booking '${turn.text}': ${problems.join("; ")} :: ${result.reply.replace(/\s+/g, " ").slice(0, 180)}`);
  }

  for (const trip of archivedTrips) {
    checks += 1;
    const result = await ask(`${trip.route_name} аялал байна уу`, conversationId(`archived-${trip.id}`));
    const problems = checkCommon(result.reply);
    if (!result.reply.trim()) problems.push("empty archived-trip reply");
    if (!includesAnyCaseInsensitive(result.reply, ["идэвхгүй", "дууссан", "шинэ огноо", "зөвлөх", "одоогоор"])) {
      problems.push("archived trip did not get a deactivated/unavailable-style reply");
    }
    if (result.brochureUrl || result.mediaUrls.length) problems.push("archived trip sent media");
    if (problems.length) failures.push(`${trip.route_name} archived behavior: ${problems.join("; ")}`);
  }

  console.log(`Checks: ${checks}`);
  if (failures.length) {
    console.error(`FAILURES (${failures.length})`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("All current-catalog checks passed.");
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
