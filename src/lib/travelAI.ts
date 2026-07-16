import { askOpenAIParts, type OpenAIPart } from "./openaiProvider";
import {
  classifyError,
  logError,
  logInfo,
  logWarn,
  recordCounter,
} from "./observability";
import { queryNeon } from "./neonDb";
import type { AITripAction, ConflictSeverity, ConflictItem, AIChangeProposal } from "./travelTypes";
import { wait, ensureTravelSchema, listTrips, getTripById, upsertTrip, patchTrip, deleteTrip, resolveTripIdByMatch, mapTripRow, normalizeProposal, parseJsonFromModel, proposalFallbackFromRawText, dedupeStrings, estimateInlineBytes } from "./travelDb";
import type { TravelTrip } from "./travelTypes";
import {
  AI_CHANGE_OPENAI_TIMEOUT_MS,
  AI_CHANGE_OPENAI_MAX_RETRIES,
  AI_CHANGE_REPAIR_TIMEOUT_MS,
  FILE_PARSE_MODEL,
  OPENAI_FILE_PARSE_MODEL,
  FILE_PARSE_VERIFY,
  FILE_PARSE_VERIFY_TIMEOUT_MS,
  FILE_PARSE_OPENAI_TIMEOUT_MS,
  FILE_PARSE_OPENAI_MAX_RETRIES,
  FILE_PARSE_BATCH_DELAY_MS,
  FILE_PARSE_TOTAL_BUDGET_MS,
  FILE_PARSE_MIN_BATCH_TIMEOUT_MS,
  FILE_PARSE_REPAIR_TIMEOUT_MS,
} from "./travelDb";
import {
  normalizeTripName,
  tokenCoverageScore,
} from "./tripPhotoImport/normalize";
// Proposal validation & conflict classification lives in travelAIValidation.ts
// (kept this file under the 2,000-line cap). Import the few symbols used
// internally here, and re-export the whole set so travelOps/tests are unaffected.
import {
  instructionForbidsTripCreation,
  isMissingTripName,
  validateAIChangeProposal,
  dedupeActions,
} from "./travelAIValidation";
export * from "./travelAIValidation";
// Prompt-string builders live in travelAIGuides.ts (kept this file under the cap).
import { buildProposalGuide, buildProposalRepairGuide } from "./travelAIGuides";

type AIActionSnapshot = {
  action: AITripAction;
  trip_id: string;
  before: TravelTrip | null;
  after: TravelTrip | null;
};

type ProposalSource = {
  label: string;
  contentText?: string;
  inline?: { mimeType: string; data: string } | null;
  fbAttachmentId?: string;
  photoUrls?: string[];
};

function buildBatchSourceParts(input: {
  note?: string;
  sources: ProposalSource[];
}) {
  const parts: OpenAIPart[] = [];
  const sourceLabels = input.sources.map((source) => source.label).join(", ");
  const guidance = [
    `Sources: ${sourceLabels}`,
    input.note ? `Admin note: ${input.note}` : "",
    "Extract travel information from the attached files, images, or text, including route, operator, price, seats, departure date, meals, and status.",
    "EVIDENCE RULE: sources whose names share the same original filename are text and visual evidence for ONE document. Reconcile them into one tour record; never create duplicate actions for parsed-text and visual-page sources.",
    "Use BOTH the parsed text and rendered page image. Before declaring a field missing, re-check page 1 visually, its headings, and nearby blocks. A missed extraction is not a document conflict.",
    "ACCURACY IS THE TOP PRIORITY. Read carefully and do not rush.",
    "Read EVERY trip/row in the source. Do not skip rows and do not stop early. If the source lists 12 trips, return actions for all 12.",
    "Never merge two different trips into one, and never split one trip into two. Each distinct route = one action.",
    "MESSENGER-SPLIT POSTER RULE: if several attached images come from the same '*-messenger-split.zip', treat them as slices/pages of ONE poster unless a later slice clearly starts a new complete product with its own top-level title AND price/date table. Numbered day-card headings such as 'Day 6: Chongqing-Hohhot', city stop headings, meal rows, and route legs are itinerary items inside the parent tour, not separate trips.",
    "TRIP VARIANT RULE: the same destination with a different transport mode (flight, ground/bus, rail, combined), duration, itinerary, or package type is a DIFFERENT trip and must stay in a separate action. Different departure dates alone remain one trip with date groups.",
    "PHOTO SOURCE RULE: write the exact source label shown in Sources into fields.extra.source_file_name for every extracted action. When one ZIP contains trip-named folders, use each image's full folder path to decide which trip it belongs to; never assign a generic numbered image by list order.",
    "Copy prices, seat counts, and dates EXACTLY as written in the source — digit for digit. Do not round, estimate, convert, or 'fix' numbers. If a price is 4,290,000 write 4290000, not 4300000.",
    "Only use information that is actually present in the source. Never invent or guess a price, date, or field. If a field is missing, leave it out rather than filling a plausible value.",
    "If any value is unclear or hard to read, keep needs_confirmation=true and ask about that exact value in plain language instead of guessing.",
    "Ignore logos, agency headers, footers, contact details, and page decorations UNLESS they contain trip-specific data (price, date, seats) attached to a real trip row.",
    "The route_name must be the DESTINATION or TRIP TITLE (e.g. 'Хөх хот', 'Тэнгэрийн хаалга-Чунчин', 'Шанхай+Ханжоу'). NEVER use the agency name as the route_name.",
    "TITLE VS ROUTE: route_name is the canonical tour/product title used by this database. Store the actual path such as 'УБ-Энши-Чунчин-Жанжиажэ' separately in fields.extra.route. Store the same canonical title in fields.extra.tour_title.",
    "Read the canonical title from the largest title block near the top of page 1. Correct harmless OCR spelling errors, but preserve the source typo in fields.extra.original_title_text. Ask only if the correction changes meaning.",
    "If the document is from UUDAM TRAVEL AGENCY and no other operator is named, set operator_name to 'UUDAM TRAVEL AGENCY' — do not leave it blank.",
    "Treat UUDAM, UUDAM TRAVEL, and UUDAM TRAVEL AGENCY as the same brand and normalize them to 'UUDAM TRAVEL AGENCY'. A clear page-1 logo/header/contact match gives high operator confidence and MUST NOT create an operator question.",
    "Never use the filename as operator when a visible operator exists. The filename may hint at the tour title only. Ask about operator only when two genuinely different companies compete in main logo/header positions.",
    "CANCELLATION RULE: Never use action='cancel', never set status='cancelled', and never write a cancellation warning UNLESS the document contains explicit cancellation language such as: цуцлагдсан, цуцлагдлаа, цуцлах, canceled, cancelled, trip cancelled, no longer available, зогсоосон, худалдаалагдахгүй. Normal itinerary end-phrases such as 'аялал өндөрлөнө', 'буцна', 'ниссэнээр аялал өндөрлөнө', 'чөлөөт өдөр', 'аялал дуусна' do NOT mean cancellation — they are normal tour program language. If the PDF has a title, price, dates, duration, and itinerary, classify it as an active tour (status='active').",
    "SOLD-OUT RULE: Never set status='sold_out' or seats_left=0 or seats_total=0 UNLESS the document explicitly says: суудал дууссан, суудал дүүрсэн, sold out, fully booked, no seats left, бүрэн захиалагдсан. Booking-intent phrases such as 'суудал авах', 'суудал нөөцлөх', 'захиалга хийх', 'холбогдоорой', 'утасдана уу' mean the tour IS AVAILABLE and open for booking — these are the OPPOSITE of sold out. If the PDF has prices and future departure dates, always default to status='active'.",
    "STALE RECORD RULE: If an existing database record has departure dates from a different year (e.g. 2023, 2024) and the uploaded PDF clearly has NEW departure dates for 2025 or 2026, do NOT use action='patch' on the old record. Create a NEW action='upsert' with the new dates instead. Only match and patch an existing record when the trip title, destination, duration, AND year/season all clearly refer to the same product run.",
    "Do not treat normal adult/child price differences as conflicts. An adult price HIGHER than the child price is normal and expected — NEVER flag it, never ask about it. Only flag the child/adult price if the CHILD price is higher than the adult price, or the source is genuinely unreadable.",
    "If a departure date IS written in the source (e.g. '06/10, 06/19, 06/22' or '06 сарын 17-21'), put it in departure_dates and treat it as known. NEVER list dates you found and then say the date is 'unclear' or 'тодорхойгүй' — that is a contradiction and is forbidden. Only flag a missing date if there is genuinely NO date anywhere in the source for that trip.",
    "Search date headings and variants: АЯЛЛЫН ОГНОО, АЯЛЛЫН ОГНОО / ХУВААРЬ, АЯЛЛЫН ОГНОО/ХУГАЦАА, ОГНОО, ХУВААРЬ. Expand '6 сарын 4, 11, 18' into usable departure_dates and also store grouped month/day data in fields.extra.departure_date_groups. Missing year is not a conflict; use year=null in extra.",
    "If recurring text (Пүрэв/Баасан гариг болгон, долоо хоног бүр, сар бүр) and exact dates both exist, keep BOTH: recurring text in departure_dates and fields.extra.recurring_schedule, exact dates in departure_dates. They support each other and are not a conflict.",
    "Normalize duration such as '8 өдөр / 7 шөнө' into duration_text and fields.extra.duration_days=8, duration_nights=7. Matching repeated durations are not conflicts; two different meaningful durations are blockers.",
    "When a trip has base prices in MNT plus a medical/exam fee in CNY, store the base adult/child prices as MNT and write the CNY fee clearly in notes/source_description.",
    "Keep currencies separate: adult_price/child_price and currency hold the base price, while CNY medical fees, infant prices, and single-room supplements go into fields.extra.foreign_currency_fees / infant_prices / single_room_supplements and are repeated clearly in notes. Never add MNT and CNY together.",
    "A malformed price such as '2,6360,000₮' is a real OCR warning. Do not guess. Create one precise blocker quoting the exact malformed text and plausible interpretations when justified.",
    "Store transport, included items, excluded items, daily itinerary, source filename, and per-field confidence in fields.extra. Confidence is high when page-1 label/visual and text agree, medium when readable once, low only when cut off/garbled/ambiguous.",
    "Optional add-on costs in CNY/yuan (нэмэлт төлбөр, өөрийн зардлаар, single room fees, extra attraction tickets) are not conflicts; keep them in notes/source_description.",
    "Recurring schedules such as 'Пүрэв гараг бүр' are valid departure_dates; do not report them as missing dates.",
    "If meals are generally included but specific days/meals are self-paid or unavailable, set has_food=true and write the exceptions in notes/source_description instead of raising a meal conflict.",
    "If a source lists хөтөлбөртэй and чөлөөт package prices for the same route, prefer separate actions with route names that include the variant instead of forcing one base price.",
    "Do not infer the operator from the uploaded filename when the document content already has a brand/operator.",
    "If possible, match against existing trips to update them; otherwise propose adding new trips.",
    "The Admin note is a hard operation constraint. If it says do not add/create trips or says to only fill/update names, return PATCH actions targeting existing trip_id values only. Never return an upsert/create action in that mode.",
    "For an ordered rename of unnamed trips from a complete source, map source names to the existing unnamed trips by created_order (1, 2, 3...). If the source label says it is part/chunk X/Y, match each row by its price, dates, duration, and other fields instead of restarting at created_order=1. Change route_name only; preserve all other fields.",
    "",
    "CRITICAL — count every distinct trip in the source and produce one action per trip:",
    "A single PDF may contain 2, 3, or more separate trips on different pages or sections. Read the ENTIRE document. Each distinct destination/package = one action. Do NOT stop after finding the first trip.",
    "To identify trip boundaries: look for new price tables, new route headings, new departure date sets, or new itinerary blocks. Each new combination = a new trip.",
    "",
    "CRITICAL — Date-based pricing rule (most common travel agency pattern):",
    "When the SAME trip name has DIFFERENT prices for DIFFERENT departure dates or months, this is NOT a conflict — it is normal seasonal/date pricing.",
    "Correct behavior: create ONE trip action with ALL departure_dates combined, set adult_price to the LOWEST (base/earliest) price among all groups, set child_price to the corresponding lowest child price, and ALWAYS populate fields.extra.departure_date_groups with every group.",
    "fields.extra.departure_date_groups format — you MUST fill this whenever prices differ by date:",
    '  "departure_date_groups": [',
    '    { "label": "A бүлэг", "dates": ["6 сарын 27"], "adult_price": 3590000, "child_price": 3260000, "infant_price": null, "notes": "" },',
    '    { "label": "B бүлэг", "dates": ["7 сарын 18", "8 сарын 8"], "adult_price": 3660000, "child_price": 3260000, "infant_price": null, "notes": "" }',
    "  ]",
    "Also write ALL date-specific prices in notes/source_description in plain Mongolian (e.g. '6 сарын 27: Том хүн 3,590,000₮ / Хүүхэд 3,260,000₮; 7 сарын 18, 8 сарын 8: Том хүн 3,660,000₮ / Хүүхэд 3,260,000₮').",
    "NEVER raise a conflict or ask the user when prices differ only because departure dates or months differ.",
    "DATE-PRICE GROUP PATTERN: Many Mongolian travel programs show prices in grouped blocks: a date heading followed by adult and child prices for that specific date. These are NOT competing prices — they are separate departure options. Each group goes into departure_date_groups AND all dates go into departure_dates.",
    "PASSENGER TYPE PRICES: adult_price > child_price > infant_price is always normal and expected. Never compare adult vs child vs infant prices as if they conflict. They are different passenger categories.",
    "A true price conflict is ONLY when: same trip name + same exact departure date + same passenger type + two different prices + no explanation. ALL four conditions must be true simultaneously.",
    "Before flagging any price conflict, first check: do the different prices correspond to different dates, months, passenger types, room types, or packages? If ANY of those differ → store all in notes, no conflict, no question.",
    "QUESTION GATE: ask a human only for a required low-confidence value or two meaningful values that genuinely disagree. The question must quote the exact tour and exact conflicting text, and the answer must change a database value. Never emit a generic 'route/operator/price/date unclear' question.",
    "BATCH RULE: each PDF is one separate tour unless that PDF visibly contains multiple complete products. Different filenames, routes, dates, prices, or the same operator across PDFs are expected and are not cross-file conflicts.",
    "",
    "CRITICAL — count every distinct trip in the source and produce one action per trip:",
    "A document may contain 10, 20, or 30+ numbered trips. Read the ENTIRE document. Each distinct destination/package = one action. Do NOT stop after the first few trips.",
    "Numbered list rule: every numbered TRIP heading (1, 2, 3 … or #1, #2 introducing a distinct route/destination with its own price) marks a new trip. Count those first, then produce exactly that many actions. If you produce fewer, set needs_confirmation=true and add a conflict 'N аялал илэрлээ, M-г боловсруулсан — бүрэн уншина уу'.",
    "NOT separate trips — never count these as trips: 'DAY 1/DAY 2', 'ӨДӨР 1', or date headings inside an itinerary (those are days WITHIN one trip); numbered activity/included-items lists; multiple uploaded images that are slices or pages of the SAME poster (same title/route across images = ONE trip, merge them into one action).",
    "Table/free-form rule: trip boundaries = new price table + new route heading + new departure dates = new trip.",
    "",
    "YEAR RULE: If the source only lists month and day (e.g. '6 сарын 4', '07/16') WITHOUT a year, do NOT invent a year. Do not write 2023, 2024, or any year that is not stated. Store month-day only in extra.departure_date_groups with year: null. If there is no year anywhere in the source, set needs_confirmation=true with one single question 'Эдгээр аяллын жилийг тодруулна уу (2025 эсвэл 2026?)' — never silently assume a year.",
    "SEATS RULE: If the source does NOT state a seat count, set seats_total=null and seats_left=null. NEVER output seats_total=0 unless the source explicitly says '0 суудал' or 'sold out'. A 0 value means the tour is full, which is dangerous if invented.",
    "FLEXIBLE DEPARTURE RULE: If a tour says 'хүссэн өдрөө сонгоно', '15+ хүнтэй групп өдрөө сонгоно', 'group may choose date', or similar — the departure date is NOT fixed. In this case: leave departure_dates empty/null, store the rule text in notes and in extra.recurring_schedule. NEVER invent example dates like '2025-07-15' for a flexible tour.",
    "BOOKING TERMS RULE: if the source states any of deposit/prepayment (урьдчилгаа), payment method or timing (төлбөр), required documents (бүрдүүлэх бичиг баримт, паспорт, гэрэл зураг), visa (виз), or cancellation/refund policy (цуцлалт, буцаан олголт), put them in fields.extra.booking_terms as { deposit, payment, documents, visa, cancellation } — short Mongolian strings copied from the source. Leave any field that is NOT stated as an empty string; NEVER invent a deposit amount, document list, visa rule, or cancellation policy.",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push({ text: guidance });

  for (const source of input.sources) {
    if (source.contentText && source.contentText.trim()) {
      parts.push({
        text: `File contents (${source.label}) (HTML/text):\n${source.contentText.trim()}`,
      });
    }
    if (source.inline) {
      parts.push({ text: `Attached binary file: ${source.label}` });
      parts.push({ inlineData: source.inline });
    }
  }

  return { parts, sourceLabels };
}

// Max chars per individual OpenAI call for text-only sources. JSON-mode
// structured extraction can be slow, so keep each call small.
const MAX_TEXT_CHARS_PER_BATCH = 18_000;
// Max numbered trips per chunk. Even a small char count can hold many trips,
// and emitting many trip JSON objects (with full extra metadata) in one call
// blows past the 45s timeout. 4 keeps each OpenAI call fast (~15-20s).
const MAX_TRIPS_PER_CHUNK = 4;

/** Counts numbered-heading lines ("1.", "2.", "12)") in the text. */
function countNumberedTrips(text: string): number {
  const matches = text.match(/(?:^|\n)[ \t]*\d{1,2}[.)]/g);
  return matches ? matches.length : 0;
}

/**
 * Splits a plain-text string into chunks at numbered-trip boundaries
 * ("1.", "2." …). Each chunk holds at most MAX_TRIPS_PER_CHUNK trips and
 * stays under maxChars. Falls back to hard char slicing if no boundaries.
 */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  // Collect positions of numbered headings (each starts a new trip block)
  const positions: number[] = [0];
  const re = /\n[ \t]*\d{1,2}[.)]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const pos = m.index + 1; // position right after the \n
    if (pos - positions[positions.length - 1] > 100) {
      positions.push(pos);
    }
  }

  // No numbered structure → fall back to plain char slicing.
  if (positions.length < 2) {
    if (text.length <= maxChars) return [text];
    const out: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      out.push(text.slice(i, i + maxChars));
    }
    return out;
  }

  // Walk trip boundaries, flushing when a chunk reaches the trip cap OR the
  // char cap. positions[i] is the start of trip i; text.length ends the last.
  const chunks: string[] = [];
  let start = 0;
  let tripsInChunk = 0;

  for (let i = 1; i <= positions.length; i++) {
    const end = i < positions.length ? positions[i] : text.length;
    tripsInChunk++;
    const chunkLen = end - start;
    const atEnd = i === positions.length;

    if (tripsInChunk >= MAX_TRIPS_PER_CHUNK || chunkLen >= maxChars || atEnd) {
      const slice = text.slice(start, end).trim();
      if (slice) chunks.push(slice);
      start = end;
      tripsInChunk = 0;
    }
  }

  // Hard-split any chunk still over the char limit.
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxChars) {
        result.push(chunk.slice(i, i + maxChars));
      }
    }
  }

  return result.length > 0 ? result : [text];
}

/**
 * Expands sources: a text source that is either large (> MAX_TEXT_CHARS_PER_BATCH)
 * OR holds many numbered trips (> MAX_TRIPS_PER_CHUNK) is split into multiple
 * labelled sources so each gets its own fast OpenAI call.
 */
function splitLargeTextSources(
  sources: ProposalSource[],
): typeof sources {
  const result: typeof sources = [];
  for (const source of sources) {
    const text = source.contentText ?? "";
    const tripCount = countNumberedTrips(text);
    const needsSplit =
      !source.inline &&
      (text.length > MAX_TEXT_CHARS_PER_BATCH || tripCount > MAX_TRIPS_PER_CHUNK);

    if (needsSplit) {
      const chunks = splitTextIntoChunks(text, MAX_TEXT_CHARS_PER_BATCH);
      const total = chunks.length;
      logInfo("travel.ai.text_source_split", {
        source: "travel.ops.file_parse",
        label: source.label,
        textChars: text.length,
        tripCount,
        chunkCount: total,
      });
      chunks.forEach((chunk, idx) => {
        result.push({
          label: `${source.label}.part-${String(idx + 1).padStart(3, "0")}-of-${String(total).padStart(3, "0")}.txt`,
          contentText: chunk,
          inline: null,
          fbAttachmentId: idx === 0 ? source.fbAttachmentId : undefined,
        });
      });
    } else {
      result.push(source);
    }
  }
  return result;
}

function chunkProposalSources(
  sources: ProposalSource[],
) {
  const MAX_INLINE_SOURCES_PER_BATCH = 2;
  const MAX_INLINE_BYTES_PER_BATCH = 12 * 1024 * 1024;
  // Keep this in sync with MAX_TEXT_CHARS_PER_BATCH so pre-split text chunks
  // don't get merged back into a single oversized batch.
  const MAX_TEXT_CHARS_PER_BATCH_LOCAL = MAX_TEXT_CHARS_PER_BATCH;
  const batches: Array<typeof sources> = [];
  let current: typeof sources = [];
  let inlineCount = 0;
  let inlineBytes = 0;
  let textChars = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      inlineCount = 0;
      inlineBytes = 0;
      textChars = 0;
    }
  };

  for (const source of sources) {
    const sourceInlineBytes = estimateInlineBytes(source.inline?.data);
    const sourceInlineCount = source.inline ? 1 : 0;
    const sourceTextChars = source.contentText?.length ?? 0;
    // A pre-split chunk (".part-NNN-of-NNN") must occupy its OWN batch so two
    // small chunks are never merged back into one big trips-per-call request.
    const isPreSplitChunk = /\.part-\d{3}-of-\d{3}\.txt$/.test(source.label);
    const exceedsCurrentBatch =
      current.length > 0 &&
      (isPreSplitChunk ||
        inlineCount + sourceInlineCount > MAX_INLINE_SOURCES_PER_BATCH ||
        inlineBytes + sourceInlineBytes > MAX_INLINE_BYTES_PER_BATCH ||
        textChars + sourceTextChars > MAX_TEXT_CHARS_PER_BATCH_LOCAL);

    if (exceedsCurrentBatch) {
      flush();
    }

    current.push(source);
    inlineCount += sourceInlineCount;
    inlineBytes += sourceInlineBytes;
    textChars += sourceTextChars;

    // Close the batch immediately after a pre-split chunk so the next chunk
    // starts fresh in its own batch.
    if (isPreSplitChunk) {
      flush();
    }
  }

  flush();
  return batches;
}

function mergeBatchProposals(
  proposals: AIChangeProposal[],
  batchCount: number,
): AIChangeProposal {
  const actions = dedupeActions(proposals.flatMap((proposal) => proposal.actions || []));
  const conflicts = dedupeStrings(
    proposals.flatMap((proposal) => proposal.conflicts || []),
  );
  const importantReasons = dedupeStrings(
    proposals
      .map((proposal) => proposal.important_reason)
      .filter((value) => String(value || "").trim().length > 0),
  );
  const summaries = dedupeStrings(
    proposals
      .map((proposal) => proposal.summary)
      .filter((value) => String(value || "").trim().length > 0),
  );

  const conflict_items: ConflictItem[] = dedupeStrings(
    proposals.flatMap((proposal) => proposal.conflict_items || []).map((item) => JSON.stringify(item)),
  ).map((s) => JSON.parse(s) as ConflictItem);

  return {
    summary:
      summaries[0] && proposals.length === 1
        ? summaries[0]
        : actions.length > 0
          ? `${batchCount} хэсгээс ${actions.length} өөрчлөлтийн санал бэлэн боллоо.`
          : `${batchCount} хэсгийг уншсан ч аюулгүй хадгалах өөрчлөлт олдсонгүй.`,
    needs_confirmation: proposals.some((proposal) => proposal.needs_confirmation),
    important_reason: importantReasons.join(" | "),
    conflicts,
    conflict_items,
    actions,
  };
}

/**
 * Verification pass: re-reads the SAME source (image/file/text) together with
 * the AI's extracted actions and asks the model to confirm every price, date,
 * and seat count matches the source EXACTLY. Returns a list of plain-language
 * mismatches. Any mismatch forces needs_confirmation=true so a human checks it
 * before it's saved. Best-effort — if the verify call fails, we keep the
 * original proposal but flag it for confirmation (fail safe, not fail open).
 */
function buildVerificationGuide(proposalActions: unknown): string {
  return [
    "You are a STRICT verifier. The same source (image/file/text) is attached.",
    "Below is data a previous step extracted from that source. Your ONLY job is to",
    "check whether every price, departure date, seat count, duration, and route name",
    "in the extracted data matches the source EXACTLY — digit for digit, date for date.",
    "",
    "Extracted data (JSON):",
    JSON.stringify(proposalActions),
    "",
    "Return ONLY JSON: { \"all_correct\": boolean, \"mismatches\": string[] }.",
    "- For each value that does NOT match the source, add one short Mongolian line to",
    "  mismatches naming the trip and the wrong field (e.g. 'Бээжин: үнэ 4290000 гэж",
    "  байгаа ч зурагт 4920000 байна').",
    "- CRITICAL: before reporting a mismatch, compare the two values as NUMBERS/DATES,",
    "  ignoring commas, currency symbols (₮, MNT), and whitespace. '2,390,000' and",
    "  '2,390,000₮' are THE SAME VALUE — do not report that as a mismatch. Only report",
    "  a mismatch when the underlying number, date, or text is actually different.",
    "- If a value in the source is genuinely unreadable, list it as a mismatch too.",
    "- If everything matches exactly, return all_correct=true and mismatches=[].",
    "- Do NOT invent trips or add new data. Only verify what is given.",
  ].join("\n");
}

/**
 * Safety net for the verifier itself: despite the prompt instruction, the
 * model sometimes reports a "mismatch" where both quoted values are actually
 * identical once you strip formatting — e.g. "үнэ 2,390,000 гэж байгаа ч
 * зурагт 2,390,000₮ байна" (currency symbol only) or the same date range
 * twice. Extract every number/date-like token from the mismatch text; if
 * there are exactly two distinct-looking tokens and they normalize equal,
 * this is a false positive and must not become a clarification question.
 */
function isFalsePositiveMismatch(text: string): boolean {
  const tokens = (text.match(/[\d]+(?:[.,][\d]+)*\s*(?:₮|төгрөг|сар[а-я]*\s*\d+[\d,\s-]*)?/g) ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  // Need at least two value-like tokens to compare "old" vs "new".
  if (tokens.length < 2) return false;
  const normalize = (t: string) => t.replace(/[₮\s]|төгрөг/g, "").replace(/,/g, "");
  const normalized = tokens.map(normalize);
  // Every extracted value normalizes the same → nothing actually differs,
  // regardless of how many times the model repeated it.
  return normalized.every((n) => n === normalized[0]);
}

async function verifyProposalAgainstSource(opts: {
  proposal: AIChangeProposal;
  userParts: OpenAIPart[];
  source: string;
  model?: string;
}): Promise<AIChangeProposal> {
  // Nothing to verify if there are no concrete actions.
  if (!opts.proposal.actions.length) return opts.proposal;

  try {
    const result = await askOpenAIParts(
      [{ text: buildVerificationGuide(opts.proposal.actions) }, ...opts.userParts],
      {
        source: `${opts.source}.verify`,
        jsonMode: true,
        timeoutMs: FILE_PARSE_VERIFY_TIMEOUT_MS,
        maxRetries: 0,
        model: opts.model,
        temperature: 0,
        // File reading stays on OpenAI only.
        preferOpenAI: true,
      },
    );
    const parsed = parseJsonFromModel(result.text) as
      | { all_correct?: boolean; mismatches?: unknown }
      | null;

    if (!parsed) {
      // Couldn't verify → fail safe: require human confirmation.
      return {
        ...opts.proposal,
        needs_confirmation: true,
        important_reason:
          opts.proposal.important_reason ||
          "Баталгаажуулалтын шалгалт бүтэлгүйтсэн тул гараар шалгана уу.",
      };
    }

    const rawMismatches = Array.isArray(parsed.mismatches)
      ? parsed.mismatches.map((m) => String(m)).filter(Boolean)
      : [];
    // Drop false positives where the verifier flagged two values that are
    // actually the same after stripping formatting (currency symbol, commas).
    const mismatches = rawMismatches.filter((m) => !isFalsePositiveMismatch(m));

    if (mismatches.length === 0) {
      return opts.proposal; // verified clean (or only false-positive noise)
    }

    // Mismatches found → surface them and force confirmation.
    recordCounter("travel.ai.verify_mismatch_total", 1, {
      count: String(mismatches.length),
    });
    const mismatchItems: ConflictItem[] = mismatches.map((text) => ({
      text,
      severity: "warning" as ConflictSeverity,
      type: "verify_mismatch",
    }));
    return {
      ...opts.proposal,
      needs_confirmation: true,
      important_reason:
        "AI өөрийн уншсан мэдээллийг эх сурвалжтай тулгаж шалгахад зөрүү илэрлээ. Доорх утгуудыг гараар шалгана уу.",
      conflicts: [...opts.proposal.conflicts, ...mismatches],
      conflict_items: [...(opts.proposal.conflict_items || []), ...mismatchItems],
    };
  } catch (error) {
    logWarn("travel.ai.verify_failed", {
      source: opts.source,
      message: error instanceof Error ? error.message : String(error),
    });
    // Fail safe — flag for human review rather than trusting unverified data.
    return {
      ...opts.proposal,
      needs_confirmation: true,
      important_reason:
        opts.proposal.important_reason ||
        "Баталгаажуулалт хийгдсэнгүй тул гараар шалгана уу.",
    };
  }
}

async function requestProposalFromModel(opts: {
  condensedTrips: unknown;
  userParts: OpenAIPart[];
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  model?: string;
  verify?: boolean;
}) {
  // OpenAI handles all proposal extraction (file parsing + text instructions).
  // PDF inputs are rendered/extracted before reaching this path.
  const result = await askOpenAIParts(
    [{ text: buildProposalGuide(opts.condensedTrips) }, ...opts.userParts],
    {
      source: opts.source,
      jsonMode: true,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      model: opts.model,
      preferOpenAI: true,
      openaiModel: OPENAI_FILE_PARSE_MODEL,
      maxOutputTokens: 16_384,
    },
  );

  let parsed = parseJsonFromModel(result.text);
  if (!parsed) {
    try {
      const repaired = await askOpenAIParts(
        [{ text: buildProposalRepairGuide(result.text) }],
        {
          source: `${opts.source}.repair`,
          jsonMode: true,
          timeoutMs: opts.repairTimeoutMs,
          maxRetries: 0,
          model: opts.model,
          preferOpenAI: true,
          openaiModel: OPENAI_FILE_PARSE_MODEL,
        },
      );
      parsed = parseJsonFromModel(repaired.text);
    } catch (error) {
      logError("travel.ai.proposal_repair_failed", {
        source: opts.source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const proposal = parsed
    ? normalizeProposal(parsed)
    : proposalFallbackFromRawText(result.text);

  // Second-opinion pass: only when the model output looks uncertain, not
  // on every batch (that would double AI cost/time for no benefit on the
  // ~90% of extractions that are clean). "Unsure" = the proposal already
  // carries a blocker conflict, or needs_confirmation is set, or a price is
  // missing on an otherwise-complete action — exactly the cases where a
  // second model catching a mismatch is worth the extra ~15-45s.
  const looksUncertain =
    proposal.needs_confirmation ||
    (proposal.conflict_items || []).some((c) => c.severity === "blocker") ||
    proposal.actions.some(
      (a) => (a.action === "upsert" || a.action === "patch") && a.fields?.adult_price == null,
    );
  if (opts.verify && FILE_PARSE_VERIFY && looksUncertain && proposal.actions.length > 0) {
    return verifyProposalAgainstSource({
      proposal,
      userParts: opts.userParts,
      source: opts.source,
      model: opts.model,
    });
  }

  return proposal;
}

async function requestProposalFromPrompt(opts: {
  prompt: string;
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
}) {
  const result = await askOpenAIParts([{ text: opts.prompt }], {
    source: opts.source,
    jsonMode: true,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });

  let parsed = parseJsonFromModel(result.text);
  if (!parsed) {
    try {
      const repaired = await askOpenAIParts(
        [{ text: buildProposalRepairGuide(result.text) }],
        {
          source: `${opts.source}.repair`,
          jsonMode: true,
          timeoutMs: opts.repairTimeoutMs,
          maxRetries: 0,
        },
      );
      parsed = parseJsonFromModel(repaired.text);
    } catch (error) {
      logError("travel.ai.proposal_repair_failed", {
        source: opts.source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return parsed ? normalizeProposal(parsed) : proposalFallbackFromRawText(result.text);
}

async function createProposal(opts: {
  instruction: string;
  source: string;
  userParts?: OpenAIPart[];
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  buildProposal?: (condensedTrips: unknown) => Promise<AIChangeProposal>;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { proposal: normalizeProposal(null), request_id: null };
  }

  const trips = await listTrips({ limit: 250 });
  const tripsInCreatedOrder = [...trips].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  let unnamedOrder = 0;
  const condensedTrips = tripsInCreatedOrder.map((trip) => ({
    id: trip.id,
    category: trip.category,
    operator_name: trip.operator_name,
    route_name: trip.route_name,
    status: trip.status,
    seats_left: trip.seats_left,
    seats_total: trip.seats_total,
    has_food: trip.has_food,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    currency: trip.currency,
    duration_text: trip.duration_text,
    departure_dates: trip.departure_dates,
    created_at: trip.created_at,
    created_order: isMissingTripName(trip.route_name) ? ++unnamedOrder : undefined,
  }));
  // Full trips are passed to validation so alias/fuzzy matching can use
  // extra.aliases and other fields when resolving AI-generated match targets.

  let proposal = normalizeProposal(null);
  try {
    if (typeof opts.buildProposal === "function") {
      proposal = normalizeProposal(await opts.buildProposal(condensedTrips));
    } else {
      // Route through requestProposalFromModel so the text-instruction path
      // gets the same JSON-repair + graceful fallback as the file path.
      proposal = normalizeProposal(
        await requestProposalFromModel({
          condensedTrips,
          userParts: opts.userParts || [],
          source: opts.source,
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          repairTimeoutMs: opts.repairTimeoutMs,
        }),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyError(error);
    logWarn("travel.ai.proposal_failed", {
      source: opts.source,
      classification,
      message,
    });
    // Surface the real reason instead of a misleading "couldn't parse JSON".
    const rateLimited = classification.category === "rate_limited";
    const timedOut = classification.category === "timeout";
    const circuitOpen = classification.category === "circuit_open";
    const failureSummary = rateLimited
      ? "AI service is temporarily rate limited."
      : timedOut
        ? "AI service took too long to answer."
        : circuitOpen
          ? "AI service is temporarily unavailable."
          : "AI service could not generate a proposal.";
    proposal = {
      summary: failureSummary,
      needs_confirmation: true,
      important_reason: message.slice(0, 300),
      conflicts: [],
      conflict_items: [],
      actions: [],
    };
  }
  proposal = validateAIChangeProposal(proposal, trips, {
    forbidCreate: instructionForbidsTripCreation(opts.instruction),
  }).proposal;

  let inserted: Awaited<ReturnType<typeof queryNeon<{ id: number }>>> = null;
  try {
    inserted = await queryNeon<{ id: number }>(
      `
        INSERT INTO travel_ai_change_requests (
          instruction,
          proposal_json,
          conflicts,
          needs_confirmation,
          status
        )
        VALUES ($1, $2::jsonb, $3::text[], $4, 'pending')
        RETURNING id
      `,
      [
        opts.instruction,
        JSON.stringify(proposal),
        proposal.conflicts,
        proposal.needs_confirmation,
      ],
    );
  } catch (insertError) {
    logError("travel.ai.proposal_insert_failed", {
      source: opts.source,
      message:
        insertError instanceof Error ? insertError.message : String(insertError),
    });
  }

  return {
    proposal,
    request_id: inserted?.rows?.[0]?.id ?? null,
  };
}

// A pasted instruction this long is almost always bulk data (a whole price
// list), not a single command. Sending it as one giant prompt is what made the
// AI time out / hit rate limits, so above this size we route it through the
// chunk-and-merge batch pipeline instead.
const LARGE_INSTRUCTION_CHARS = 6_000;

// Heuristic: does the long text look like a multi-row price list (worth
// splitting) rather than one long sentence? Many lines or repeated price/seat
// cues signal bulk data.
function looksLikeBulkPaste(instruction: string): boolean {
  const lines = instruction.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 12) return true;
  const priceCues = (instruction.match(/₮|төгрөг|\bMNT\b|\bCNY\b|юань|\d[\d ,]{4,}/gi) || [])
    .length;
  return priceCues >= 8;
}

export async function generateAIProposal(instruction: string) {
  // Big pasted price lists go through the batched (chunk + merge) pipeline so a
  // single oversized prompt can't time out or get rate-limited. Normal short
  // commands keep the fast, direct single-request path.
  if (
    instruction.length >= LARGE_INSTRUCTION_CHARS &&
    looksLikeBulkPaste(instruction)
  ) {
    return generateAIProposalFromContentBatched({
      label: "Шивсэн прайс жагсаалт",
      contentText: instruction,
    });
  }

  return createProposal({
    instruction,
    userParts: [{ text: `Хэрэглэгчийн хүсэлт: ${instruction}` }],
    source: "travel.ops.ai_change",
    timeoutMs: AI_CHANGE_OPENAI_TIMEOUT_MS,
    maxRetries: AI_CHANGE_OPENAI_MAX_RETRIES,
    repairTimeoutMs: AI_CHANGE_REPAIR_TIMEOUT_MS,
  });
}

export async function generateAIProposalFromContent(input: {
  label?: string;
  note?: string;
  contentText?: string;
  inline?: { mimeType: string; data: string } | null;
  sources?: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
  }>;
}) {
  const parts: OpenAIPart[] = [];
  const sources =
    input.sources && input.sources.length > 0
      ? input.sources
      : [
          {
            label: input.label || "upload",
            contentText: input.contentText,
            inline: input.inline,
          },
        ];

  const sourceLabels = sources.map((source) => source.label).join(", ");
  const guidance = [
    `Sources: ${sourceLabels}`,
    input.note ? `Admin note: ${input.note}` : "",
    "Extract travel information from the attached files, images, or text, including route, operator, price, seats, departure date, meals, and status.",
    "ACCURACY IS THE TOP PRIORITY. Read carefully and do not rush.",
    "Read EVERY trip/row in the source. Do not skip rows and do not stop early. If the source lists 12 trips, return actions for all 12.",
    "Never merge two different trips into one, and never split one trip into two. Each distinct route = one action.",
    "TRIP VARIANT RULE: the same destination with a different transport mode (flight, ground/bus, rail, combined), duration, itinerary, or package type is a DIFFERENT trip and must stay in a separate action. Different departure dates alone remain one trip with date groups.",
    "PHOTO SOURCE RULE: write the exact source label shown in Sources into fields.extra.source_file_name for every extracted action. When one ZIP contains trip-named folders, use each image's full folder path to decide which trip it belongs to; never assign a generic numbered image by list order.",
    "Copy prices, seat counts, and dates EXACTLY as written in the source — digit for digit. Do not round, estimate, convert, or 'fix' numbers. If a price is 4,290,000 write 4290000, not 4300000.",
    "Only use information that is actually present in the source. Never invent or guess a price, date, or field. If a field is missing, leave it out rather than filling a plausible value.",
    "If any value is unclear or hard to read, keep needs_confirmation=true and ask about that exact value in plain language instead of guessing.",
    "Ignore logos, agency headers, footers, contact details, and page decorations UNLESS they contain trip-specific data (price, date, seats) attached to a real trip row.",
    "The route_name must be the DESTINATION or TRIP TITLE (e.g. 'Хөх хот', 'Тэнгэрийн хаалга-Чунчин', 'Шанхай+Ханжоу'). NEVER use the agency name as the route_name.",
    "If the document is from UUDAM TRAVEL AGENCY and no other operator is named, set operator_name to 'UUDAM TRAVEL AGENCY' — do not leave it blank.",
    "CANCELLATION RULE: Never use action='cancel', never set status='cancelled', and never write a cancellation warning UNLESS the document contains explicit cancellation language such as: цуцлагдсан, цуцлагдлаа, цуцлах, canceled, cancelled, trip cancelled, no longer available, зогсоосон, худалдаалагдахгүй. Normal itinerary end-phrases such as 'аялал өндөрлөнө', 'буцна', 'ниссэнээр аялал өндөрлөнө', 'чөлөөт өдөр', 'аялал дуусна' do NOT mean cancellation — they are normal tour program language. If the PDF has a title, price, dates, duration, and itinerary, classify it as an active tour (status='active').",
    "SOLD-OUT RULE: Never set status='sold_out' or seats_left=0 or seats_total=0 UNLESS the document explicitly says: суудал дууссан, суудал дүүрсэн, sold out, fully booked, no seats left, бүрэн захиалагдсан. Booking-intent phrases such as 'суудал авах', 'суудал нөөцлөх', 'захиалга хийх', 'холбогдоорой', 'утасдана уу' mean the tour IS AVAILABLE and open for booking — these are the OPPOSITE of sold out. If the PDF has prices and future departure dates, always default to status='active'.",
    "STALE RECORD RULE: If an existing database record has departure dates from a different year (e.g. 2023, 2024) and the uploaded PDF clearly has NEW departure dates for 2025 or 2026, do NOT use action='patch' on the old record. Create a NEW action='upsert' with the new dates instead. Only match and patch an existing record when the trip title, destination, duration, AND year/season all clearly refer to the same product run.",
    "Do not treat normal adult/child price differences as conflicts. An adult price HIGHER than the child price is normal and expected — NEVER flag it, never ask about it. Only flag the child/adult price if the CHILD price is higher than the adult price, or the source is genuinely unreadable.",
    "If a departure date IS written in the source (e.g. '06/10, 06/19, 06/22' or '06 сарын 17-21'), put it in departure_dates and treat it as known. NEVER list dates you found and then say the date is 'unclear' or 'тодорхойгүй' — that is a contradiction and is forbidden. Only flag a missing date if there is genuinely NO date anywhere in the source for that trip.",
    "Optional add-on costs in CNY/yuan (нэмэлт төлбөр, өөрийн зардлаар, single room fees, extra attraction tickets) are not conflicts; keep them in notes/source_description.",
    "Recurring schedules such as 'Пүрэв гараг бүр' are valid departure_dates; do not report them as missing dates.",
    "If meals are generally included but specific days/meals are self-paid or unavailable, set has_food=true and write the exceptions in notes/source_description instead of raising a meal conflict.",
    "If a source lists хөтөлбөртэй and чөлөөт package prices for the same route, prefer separate actions with route names that include the variant instead of forcing one base price.",
    "Do not infer the operator from the uploaded filename when the document content already has a brand/operator.",
    "If possible, match against existing trips to update them; otherwise propose adding new trips.",
    "",
    "CRITICAL — count every distinct trip in the source and produce one action per trip:",
    "A document may contain 10, 20, or 30+ numbered trips. Read the ENTIRE document. Each distinct destination/package = one action. Do NOT stop after the first few trips.",
    "Numbered list rule: every numbered TRIP heading (1, 2, 3 … or #1, #2 introducing a distinct route/destination with its own price) marks a new trip. Count those first, then produce exactly that many actions. If you produce fewer, set needs_confirmation=true and add a conflict 'N аялал илэрлээ, M-г боловсруулсан — бүрэн уншина уу'.",
    "NOT separate trips — never count these as trips: 'DAY 1/DAY 2', 'ӨДӨР 1', or date headings inside an itinerary (those are days WITHIN one trip); numbered activity/included-items lists; multiple uploaded images that are slices or pages of the SAME poster (same title/route across images = ONE trip, merge them into one action).",
    "Table/free-form rule: trip boundaries = new price table + new route heading + new departure dates = new trip.",
    "",
    "YEAR RULE: If the source only lists month and day (e.g. '6 сарын 4', '07/16') WITHOUT a year, do NOT invent a year. Do not write 2023, 2024, or any year that is not stated. Store month-day only in extra.departure_date_groups with year: null. If there is no year anywhere in the source, set needs_confirmation=true with one single question 'Эдгээр аяллын жилийг тодруулна уу (2025 эсвэл 2026?)' — never silently assume a year.",
    "",
    "CRITICAL — Date-based pricing rule (most common travel agency pattern):",
    "When the SAME trip name has DIFFERENT prices for DIFFERENT departure dates or months, this is NOT a conflict — it is normal seasonal/date pricing.",
    "Correct behavior: create ONE trip action with ALL departure_dates combined, set adult_price to the LOWEST (base/earliest) price among all groups, set child_price to the corresponding lowest child price, and ALWAYS populate fields.extra.departure_date_groups with every group.",
    "fields.extra.departure_date_groups format — you MUST fill this whenever prices differ by date:",
    '  "departure_date_groups": [',
    '    { "label": "A бүлэг", "dates": ["6 сарын 27"], "adult_price": 3590000, "child_price": 3260000, "infant_price": null, "notes": "" },',
    '    { "label": "B бүлэг", "dates": ["7 сарын 18", "8 сарын 8"], "adult_price": 3660000, "child_price": 3260000, "infant_price": null, "notes": "" }',
    "  ]",
    "Also write ALL date-specific prices in notes/source_description in plain Mongolian (e.g. '6 сарын 27: Том хүн 3,590,000₮ / Хүүхэд 3,260,000₮; 7 сарын 18, 8 сарын 8: Том хүн 3,660,000₮ / Хүүхэд 3,260,000₮').",
    "NEVER raise a conflict or ask the user when prices differ only because departure dates or months differ.",
    "DATE-PRICE GROUP PATTERN: Many Mongolian travel programs show prices in grouped blocks: a date heading followed by adult and child prices for that specific date. These are NOT competing prices — they are separate departure options. Each group goes into departure_date_groups AND all dates go into departure_dates.",
    "PASSENGER TYPE PRICES: adult_price > child_price > infant_price is always normal and expected. Never compare adult vs child vs infant prices as if they conflict.",
    "A true price conflict is ONLY when: same trip name + same exact departure date + same passenger type + two different prices + no explanation. ALL four conditions must be true simultaneously.",
    "Before flagging any price conflict, first check: do the different prices correspond to different dates, months, passenger types, room types, or packages? If ANY of those differ → store all in notes, no conflict.",
    "SEATS RULE: If the source does NOT state a seat count, set seats_total=null and seats_left=null. NEVER output seats_total=0 unless the source explicitly says '0 суудал' or 'sold out'. A 0 value means the tour is full, which is dangerous if invented.",
    "FLEXIBLE DEPARTURE RULE: If a tour says 'хүссэн өдрөө сонгоно', '15+ хүнтэй групп өдрөө сонгоно', 'group may choose date', or similar — the departure date is NOT fixed. In this case: leave departure_dates empty/null, store the rule text in notes and in extra.recurring_schedule. NEVER invent example dates like '2025-07-15' for a flexible tour.",
    "BOOKING TERMS RULE: if the source states any of deposit/prepayment (урьдчилгаа), payment method or timing (төлбөр), required documents (бүрдүүлэх бичиг баримт, паспорт, гэрэл зураг), visa (виз), or cancellation/refund policy (цуцлалт, буцаан олголт), put them in fields.extra.booking_terms as { deposit, payment, documents, visa, cancellation } — short Mongolian strings copied from the source. Leave any field that is NOT stated as an empty string; NEVER invent a deposit amount, document list, visa rule, or cancellation policy.",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push({ text: guidance });

  for (const source of sources) {
    if (source.contentText && source.contentText.trim()) {
      parts.push({
        text: `File contents (${source.label}) (HTML/text):\n${source.contentText.trim()}`,
      });
    }
    if (source.inline) {
      parts.push({ text: `Attached binary file: ${source.label}` });
      parts.push({ inlineData: source.inline });
    }
  }

  return createProposal({
    instruction: input.note
      ? `[File] ${sourceLabels} - ${input.note}`
      : `[File] ${sourceLabels}`,
    userParts: parts,
    source: "travel.ops.file_parse",
  });
}

// Trip identity key for grouping/matching actions: trip_id when present,
// otherwise the route name folded to survive case/dash/е-э spelling variance.
function tripActionKey(action: AITripAction): string {
  const id = action.trip_id?.trim();
  if (id) return `id:${id}`;
  const name =
    action.fields?.route_name?.toString().trim() ||
    action.match?.route_name?.trim() ||
    "";
  return `name:${name.toLowerCase().replace(/э/g, "е").replace(/[^\p{L}\p{N}]+/gu, "")}`;
}

function unionStringArrays(a: unknown, b: unknown): string[] {
  const clean = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return Array.from(new Set([...clean(a), ...clean(b)]));
}

function mergeActionFields(existing: AITripAction, action: AITripAction): void {
  const target = (existing.fields ?? {}) as Record<string, unknown>;
  const source = (action.fields ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(source)) {
    if (value == null || value === "") continue;
    if (field === "photo_urls" || field === "departure_dates") {
      target[field] = unionStringArrays(target[field], value);
    } else if (field === "extra" && typeof value === "object") {
      target[field] = { ...(target[field] as object ?? {}), ...(value as object) };
    } else if (
      field === "route_name" &&
      typeof target[field] === "string" &&
      typeof value === "string" &&
      value.length > (target[field] as string).length
    ) {
      // Prefer the MORE SPECIFIC name ("Жэжү арлын аялал 2026" over "Жэжү
      // арлын аялал") rather than whichever partial slice happened to come
      // first in the batch.
      target[field] = value;
    } else if (target[field] == null || target[field] === "") {
      target[field] = value;
    }
  }
  if (!existing.fields) (existing as { fields?: Record<string, unknown> }).fields = target;
}

function mergeActionIdentity(existing: AITripAction, action: AITripAction): void {
  const existingHasTarget = Boolean(existing.trip_id || existing.match?.operator_name || existing.match?.route_name);
  const incomingHasTarget = Boolean(action.trip_id || action.match?.operator_name || action.match?.route_name);
  if (existing.action === "patch" && action.action === "upsert" && !existingHasTarget) {
    existing.action = "upsert";
  }
  if (existing.action === "upsert" && action.action === "patch" && incomingHasTarget) {
    // Keep the upsert verb for now; validation will safely downgrade it to a
    // patch once the target copied below is present.
  }
  if (!existing.trip_id && action.trip_id) {
    existing.trip_id = action.trip_id;
  }
  if (!existing.match && action.match) {
    existing.match = action.match;
    return;
  }
  if (existing.match && action.match) {
    existing.match = {
      ...action.match,
      ...existing.match,
    };
  }
}

type TripProductVariant = "air" | "ground" | "combined" | "rail";

function tripProductVariant(action: AITripAction): TripProductVariant | null {
  const extra = action.fields?.extra as Record<string, unknown> | undefined;
  const text = normalizeTripName([
    action.fields?.route_name,
    action.match?.route_name,
    typeof extra?.transport === "string" ? extra.transport : "",
    typeof extra?.route === "string" ? extra.route : "",
  ].filter(Boolean).join(" "));
  if (/хосол|combined|combo/.test(text)) return "combined";
  if (/галт\s*тэрэг|train|rail/.test(text)) return "rail";
  if (/нис(?:лэг|эх|эхийн|лэгтэй)?|онгоц|flight|air/.test(text)) return "air";
  if (/газ(?:ар|рын)|автобус|bus|coach/.test(text)) return "ground";
  return null;
}

function tripDurationDays(action: AITripAction): number | null {
  const extra = action.fields?.extra as Record<string, unknown> | undefined;
  if (typeof extra?.duration_days === "number" && Number.isFinite(extra.duration_days)) {
    return extra.duration_days;
  }
  const text = normalizeTripName([
    action.fields?.duration_text,
    action.fields?.route_name,
  ].filter(Boolean).join(" "));
  const match = text.match(/\b(\d{1,2})\s*(?:өдөр|хоног|days?)\b/);
  return match ? Number(match[1]) : null;
}

function hasCompatibleProductVariant(left: AITripAction, right: AITripAction): boolean {
  const leftVariant = tripProductVariant(left);
  const rightVariant = tripProductVariant(right);
  if (leftVariant && rightVariant && leftVariant !== rightVariant) return false;
  const leftDuration = tripDurationDays(left);
  const rightDuration = tripDurationDays(right);
  return !(leftDuration && rightDuration && leftDuration !== rightDuration);
}

/**
 * Collapses multiple actions that target the SAME trip into one. Multi-image
 * uploads (a messenger-split zip = several slices of one poster) make the
 * model emit one partial action per image — e.g. one carrying dates+prices,
 * another carrying meals+photo — which showed up as confusing duplicate rows
 * and split the photos across actions. Fields fill forward (first non-empty
 * wins, except route_name prefers the longer/more specific variant), list
 * fields union.
 *
 * Pass 1 groups by exact identity (trip_id, or exact-folded route name).
 * Pass 2 catches near-duplicates an exact key can't — the SAME poster
 * sliced across images sometimes yields the trip's name with and without a
 * trailing detail ("Жэжү арлын аялал 2026" vs "Жэжү арлын аялал"). When one
 * name is a superset of the other's tokens (fuzzy match, not just prefix),
 * they're merged automatically instead of asking the admin to pick — this
 * was previously surfaced as a "хоёр өөр нэр таарсан" question for what is
 * obviously one trip.
 */
export function mergeDuplicateTripActions(proposal: AIChangeProposal): void {
  const byKey = new Map<string, AITripAction>();
  const mergedActions: AITripAction[] = [];
  for (const action of proposal.actions) {
    const verb = String(action.action || "").toLowerCase();
    const key = `${verb}|${tripActionKey(action)}`;
    const keyedAction = verb !== "cancel" ? byKey.get(key) : undefined;
    const existing = keyedAction && hasCompatibleProductVariant(keyedAction, action)
      ? keyedAction
      : undefined;
    if (!existing || key.endsWith("name:")) {
      byKey.set(key, action);
      mergedActions.push(action);
      continue;
    }
    mergeActionIdentity(existing, action);
    mergeActionFields(existing, action);
  }

  // Pass 2: fuzzy near-duplicate merge for upsert actions with no trip_id
  // (brand-new trips only — never merge across an already-resolved trip_id).
  const finalActions: AITripAction[] = [];
  for (const action of mergedActions) {
    const verb = String(action.action || "").toLowerCase();
    const name = action.fields?.route_name?.toString().trim() || action.match?.route_name?.trim() || "";
    if (verb === "cancel" || !name) {
      finalActions.push(action);
      continue;
    }
    const nameNorm = normalizeTripName(name);
    const dup = finalActions.find((existing) => {
      const existingVerb = String(existing.action || "").toLowerCase();
      if (existingVerb === "cancel" || verb === "cancel") return false;
      if (existingVerb !== verb && existingVerb !== "upsert" && existingVerb !== "patch") return false;
      if (existing.trip_id && action.trip_id && existing.trip_id !== action.trip_id) {
        return false;
      }
      const existingName =
        existing.fields?.route_name?.toString().trim() || existing.match?.route_name?.trim() || "";
      if (!existingName) return false;
      const existingNorm = normalizeTripName(existingName);
      if (!hasCompatibleProductVariant(existing, action)) return false;
      if (existingNorm === nameNorm) return true;
      // One name fully contains the other's words (a trailing year/detail
      // added or dropped) — not just generic fuzzy overlap, to avoid
      // merging two genuinely different trips that happen to share words.
      const isSupersetName = existingNorm.includes(nameNorm) || nameNorm.includes(existingNorm);
      return isSupersetName && tokenCoverageScore(existingNorm, nameNorm) >= 0.6;
    });
    if (dup) {
      mergeActionIdentity(dup, action);
      mergeActionFields(dup, action);
      continue;
    }
    finalActions.push(action);
  }

  proposal.actions = finalActions;
  mergeMessengerSplitItineraryFragments(proposal);
}

function actionRouteName(action: AITripAction): string {
  return action.fields?.route_name?.toString().trim() || action.match?.route_name?.trim() || "";
}

function actionSourceLabel(action: AITripAction): string {
  const extra = action.fields?.extra as Record<string, unknown> | undefined;
  return typeof extra?.source_file_name === "string" ? extra.source_file_name.trim() : "";
}

function isMessengerSplitSource(label: string): boolean {
  const normalized = label.toLowerCase().replace(/\\/g, "/");
  return (
    normalized.includes("messenger-split") ||
    /messenger-\d+\.(?:png|jpe?g|webp)(?:\.compressed\.jpe?g)?$/i.test(normalized)
  );
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function actionTitleMatchScore(action: AITripAction, groupLabel: string): number {
  const groupTokens = photoMatchTokens(groupLabel);
  const routeTokens = photoMatchTokens(actionRouteName(action));
  if (groupTokens.size === 0 || routeTokens.size === 0) return 0;
  const overlap = tokenOverlap(groupTokens, routeTokens);
  return Math.max(overlap / groupTokens.size, overlap / routeTokens.size);
}

function hasActionPriceOrDate(action: AITripAction): boolean {
  const fields = action.fields || {};
  return (
    typeof fields.adult_price === "number" ||
    typeof fields.child_price === "number" ||
    (Array.isArray(fields.departure_dates) && fields.departure_dates.length > 0)
  );
}

function isIncompleteItineraryFragment(action: AITripAction): boolean {
  if (hasActionPriceOrDate(action)) return false;
  const fields = action.fields || {};
  const extra = fields.extra as Record<string, unknown> | undefined;
  return Boolean(
    fields.duration_text ||
      fields.has_food != null ||
      extra?.daily_itinerary ||
      extra?.route ||
      extra?.transport,
  );
}

function mergeItineraryFragmentIntoPrimary(primary: AITripAction, fragment: AITripAction): void {
  const clone = JSON.parse(JSON.stringify(fragment)) as AITripAction;
  if (clone.fields) {
    delete clone.fields.route_name;
    const extra = clone.fields.extra as Record<string, unknown> | undefined;
    if (extra && typeof extra === "object") {
      delete extra.route;
      delete extra.tour_title;
      delete extra.original_title_text;
      delete extra.source_file_name;
    }
  }
  delete clone.match;
  mergeActionFields(primary, clone);
}

function mergeMessengerSplitItineraryFragments(proposal: AIChangeProposal): void {
  const grouped = new Map<string, AITripAction[]>();
  for (const action of proposal.actions) {
    const label = actionSourceLabel(action);
    if (!label || !isMessengerSplitSource(label)) continue;
    const group = photoSourceGroup(label);
    grouped.set(group, [...(grouped.get(group) || []), action]);
  }

  if (grouped.size === 0) return;

  const drop = new Set<AITripAction>();
  for (const [groupLabel, actions] of grouped) {
    if (actions.length < 2) continue;
    const ranked = actions
      .map((action) => ({ action, score: actionTitleMatchScore(action, groupLabel) }))
      .sort((left, right) => right.score - left.score);
    const primary = ranked[0];
    const second = ranked[1];
    if (!primary || primary.score < 0.6 || (second && second.score >= primary.score - 0.05)) {
      continue;
    }

    for (const candidate of ranked.slice(1)) {
      if (!isIncompleteItineraryFragment(candidate.action)) continue;
      mergeItineraryFragmentIntoPrimary(primary.action, candidate.action);
      drop.add(candidate.action);
    }
  }

  if (drop.size > 0) {
    proposal.actions = proposal.actions.filter((action) => !drop.has(action));
  }
}

/**
 * Restores photo_urls after a clarification revision. The revision round-trip
 * feeds the proposal back through the model, and models routinely drop the
 * long Cloudinary URLs as noise — which meant answering ONE question silently
 * cost the admin every attached photo.
 */
export function carryOverPhotoUrls(
  previous: AIChangeProposal,
  revised: AIChangeProposal,
): void {
  const photosByKey = new Map<string, string[]>();
  for (const action of previous.actions) {
    const urls = Array.isArray(action.fields?.photo_urls)
      ? action.fields.photo_urls.filter((u): u is string => typeof u === "string")
      : [];
    if (urls.length > 0) photosByKey.set(tripActionKey(action), urls);
  }
  if (photosByKey.size === 0) return;
  for (const action of revised.actions) {
    const existing = Array.isArray(action.fields?.photo_urls)
      ? action.fields.photo_urls
      : [];
    if (existing.length > 0) continue;
    const carried = photosByKey.get(tripActionKey(action));
    if (!carried) continue;
    if (!action.fields) (action as { fields?: Record<string, unknown> }).fields = {};
    (action.fields as Record<string, unknown>).photo_urls = carried;
  }
}

// Filename noise that carries no trip identity ("...-messenger-split (3).zip").
const PHOTO_LABEL_NOISE = new Set([
  "messenger", "split", "zip", "png", "jpg", "jpeg", "webp", "final",
  "copy", "image", "img", "page", "slice", "poster", "аялал", "tour",
  // processing suffixes the zip/photo pipeline appends ("...-1.png.compressed.jpg").
  // "compressed" counting as an identity token halved coverage for one-word
  // trip names (ЖАНЖИАЖИЭ АЯЛАЛ) and silently failed the 60% match bar.
  "compressed", "converted", "resized", "scaled", "optimized", "edited",
]);

function photoMatchTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/э/g, "е") // fold Mongolian е/э spelling variance (ЖАНЖИАЖИЭ vs Жанжиажие)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !PHOTO_LABEL_NOISE.has(t)),
  );
}

function normalizedPhotoLabel(value: string): string {
  return normalizeTripName(value.replace(/\\/g, "/"));
}

function photoSourceGroup(label: string): string {
  const segments = label.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length <= 1) return normalizedPhotoLabel(label);
  // The complete parent path identifies a trip photo group. Keep every nested
  // folder because ZIPs often have a wrapper folder above trip-named folders.
  return normalizedPhotoLabel(segments.slice(0, -1).join("/"));
}

/**
 * Assigns uploaded images to the trips extracted FROM them. The old exact
 * source_file_name match silently dropped every photo whenever the model
 * wrote the label differently (long Cyrillic zip names guaranteed this) and
 * more than one trip was proposed — the admin uploaded a poster zip per trip
 * and got trips with no photos. Now each photo group is matched to the action
 * whose route name shares the most identity tokens with the filename (the
 * zip naming convention literally contains the trip title), falling back to
 * exact label match and the single-action case.
 */
export function attachPhotoUrlsToActions(
  photoUrlMap: Map<string, string[]>,
  merged: AIChangeProposal,
  options?: { quiet?: boolean },
): void {
  const actions = merged.actions;
  const addUrls = (action: AITripAction, urls: string[]) => {
    if (urls.length === 0) return;
    const existing = Array.isArray(action.fields?.photo_urls)
      ? action.fields.photo_urls.filter((url): url is string => typeof url === "string")
      : [];
    if (!action.fields) (action as { fields?: Record<string, unknown> }).fields = {};
    (action.fields as Record<string, unknown>).photo_urls = Array.from(
      new Set([...existing, ...urls]),
    ).slice(0, 20);
  };

  const actionTokens = actions.map((action) => {
    const extra = action.fields?.extra as Record<string, unknown> | undefined;
    const parts = [
      action.fields?.route_name,
      action.match?.route_name,
      typeof extra?.source_file_name === "string" ? extra.source_file_name : "",
    ]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" ");
    return photoMatchTokens(parts);
  });

  const unmatchedLabels: string[] = [];
  const sourceGroups = new Set(Array.from(photoUrlMap.keys(), photoSourceGroup));
  for (const [label, urls] of photoUrlMap) {
    // 1) Exact source_file_name match still wins.
    const exactMatches = actions.filter((action) => {
      const extra = action.fields?.extra as Record<string, unknown> | undefined;
      return (
        typeof extra?.source_file_name === "string" &&
        normalizedPhotoLabel(extra.source_file_name) === normalizedPhotoLabel(label)
      );
    });
    if (exactMatches.length > 0) {
      exactMatches.forEach((action) => addUrls(action, urls));
      continue;
    }

    // 2) Token-overlap: best action whose route name shares identity tokens
    //    with the filename. Two guards against misattaching (wrong poster on
    //    a trip is worse than no poster): at least one matched token of
    //    length >= 4, AND >= 60% of the filename's identity tokens must match
    //    — so "ЖИНИНЬ ... МИНИ АВАТАР ХӨХ ХОТ.zip" can't latch onto the
    //    separate "Мини Аватар - Хөх хот - Датон" trip on partial overlap.
    const labelTokens = photoMatchTokens(label);
    const ranked: Array<{ index: number; score: number; coverage: number }> = [];
    actionTokens.forEach((tokens, i) => {
      let score = 0;
      let hasStrongToken = false;
      for (const t of labelTokens) {
        if (tokens.has(t)) {
          score += 1;
          if (t.length >= 4) hasStrongToken = true;
        }
      }
      const coverage = labelTokens.size > 0 ? score / labelTokens.size : 0;
      if (hasStrongToken && coverage >= 0.6) {
        ranked.push({ index: i, score, coverage });
      }
    });
    ranked.sort((left, right) =>
      right.score - left.score || right.coverage - left.coverage,
    );
    const best = ranked[0];
    const second = ranked[1];
    const uniqueBest = best && (
      !second || best.score > second.score || best.coverage - second.coverage >= 0.2
    );
    if (uniqueBest) {
      addUrls(actions[best.index], urls);
      continue;
    }

    // 3) One poster group with one clear parent trip -> every slice belongs
    //    there. This catches messenger-split files where one image is a pure
    //    itinerary/detail slice and its filename has too little route text to
    //    pass the strict token-overlap guard above.
    if (sourceGroups.size === 1) {
      const groupLabel = Array.from(sourceGroups)[0] || label;
      const rankedByGroup = actions
        .map((action, index) => ({ index, score: actionTitleMatchScore(action, groupLabel) }))
        .sort((left, right) => right.score - left.score);
      const bestGroup = rankedByGroup[0];
      const secondGroup = rankedByGroup[1];
      const onlyAction = actions.length === 1;
      const clearParent =
        bestGroup &&
        bestGroup.score >= 0.45 &&
        (!secondGroup || bestGroup.score - secondGroup.score >= 0.2);
      if (onlyAction || clearParent) {
        addUrls(actions[onlyAction ? 0 : bestGroup.index], urls);
        continue;
      }
    }

    // 4) Single action + one source group -> everything belongs to it. If
    //    there are multiple folders/groups, don't attach them all to one trip:
    //    that usually means the model missed another trip in the upload.
    if (actions.length === 1 && sourceGroups.size === 1) {
      addUrls(actions[0], urls);
      continue;
    }
    unmatchedLabels.push(label);
  }

  // Surface (as a non-blocking warning, never a question) any photos we
  // could not confidently place, instead of dropping them silently.
  // quiet = revision re-attach; don't re-append the warning a second time.
  if (unmatchedLabels.length > 0 && !options?.quiet) {
    const shown = unmatchedLabels.slice(0, 3).join(", ");
    const warning = `Зарим зургийг аль аялалд хамаарахыг тодорхойлж чадсангүй: ${shown}${unmatchedLabels.length > 3 ? "…" : ""}. Хадгалсны дараа "Зураг оруулах" табаас гараар нэмнэ үү.`;
    if (!merged.conflicts.includes(warning)) merged.conflicts.push(warning);
    merged.conflict_items = [
      ...(merged.conflict_items || []),
      { text: warning, severity: "warning" as ConflictSeverity, type: "photo_unmatched" },
    ];
  }
}

function attachPersistedPhotoSources(proposal: AIChangeProposal): void {
  const sources = proposal.photo_sources || [];
  if (sources.length === 0 || proposal.actions.length === 0) return;
  attachPhotoUrlsToActions(
    new Map(sources.map((source) => [source.label, source.urls])),
    proposal,
    { quiet: true },
  );
}

export async function generateAIProposalFromContentBatched(input: {
  label?: string;
  note?: string;
  contentText?: string;
  inline?: { mimeType: string; data: string } | null;
  sources?: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
    fbAttachmentId?: string;
    photoUrls?: string[];
  }>;
}) {
  const rawSources: ProposalSource[] =
    input.sources && input.sources.length > 0
      ? input.sources
      : [
          {
            label: input.label || "upload",
            contentText: input.contentText,
            inline: input.inline,
          },
        ];

  // Split any large/multi-trip text source (e.g. a 29-trip DOCX) into
  // sub-chunks so each OpenAI call only extracts a handful of trips and
  // finishes well within the per-batch timeout.
  const sources = splitLargeTextSources(rawSources);

  // Build a label → attachment_id map for post-processing.
  // Index by both the original label AND any chunk labels so the stamp step
  // finds the id regardless of whether the model wrote the original filename
  // or the chunk filename in extra.source_file_name.
  const fbAttachmentMap = new Map<string, string>();
  for (const s of rawSources) {
    if (s.fbAttachmentId) fbAttachmentMap.set(s.label, s.fbAttachmentId);
  }
  for (const s of sources) {
    if (s.fbAttachmentId) fbAttachmentMap.set(s.label, s.fbAttachmentId);
  }

  const photoUrlMap = new Map<string, string[]>();
  const addPhotoUrls = (label: string, urls?: string[]) => {
    const clean = (urls || [])
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .filter((url) => url.startsWith("https://"));
    if (clean.length === 0) return;
    photoUrlMap.set(label, Array.from(new Set([...(photoUrlMap.get(label) || []), ...clean])));
  };
  for (const s of rawSources) addPhotoUrls(s.label, s.photoUrls);
  for (const s of sources) addPhotoUrls(s.label, s.photoUrls);

  const sourceLabels = rawSources.map((source) => source.label).join(", ");
  const batches = chunkProposalSources(sources);

  return createProposal({
    instruction: input.note
      ? `[File] ${sourceLabels} - ${input.note}`
      : `[File] ${sourceLabels}`,
    source: "travel.ops.file_parse",
    buildProposal: async (condensedTrips) => {
      const proposals: AIChangeProposal[] = [];
      const startedAt = Date.now();

      for (let index = 0; index < batches.length; index += 1) {
        if (index > 0) {
          await wait(FILE_PARSE_BATCH_DELAY_MS);
        }
        const remainingMs = FILE_PARSE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
        if (remainingMs <= FILE_PARSE_MIN_BATCH_TIMEOUT_MS) {
          const remainingLabels = batches
            .slice(index)
            .flatMap((batch) => batch.map((source) => source.label))
            .join(", ");
          const skippedCount = batches.slice(index).reduce((sum, b) => sum + b.length, 0);
          proposals.push({
            summary: `Stopped reading remaining batches: ${remainingLabels}`,
            needs_confirmation: true,
            important_reason:
              "The upload was too large or slow for one safe AI parse request.",
            conflicts: [
              `Цаг хүрэлцээгүй тул ${skippedCount} хэсэг уншиж амжсангүй — энэ файлыг хадгалахаас өмнө дахин жижиг хэсгүүдэд хувааж оруулна уу. (${remainingLabels})`,
            ],
            conflict_items: [{
              text: `Цаг хүрэлцээгүй тул ${skippedCount} хэсэг уншиж амжсангүй — энэ файлыг хадгалахаас өмнө дахин жижиг хэсгүүдэд хувааж оруулна уу. (${remainingLabels})`,
              severity: "blocker" as ConflictSeverity,
              type: "batch_timeout",
            }],
            actions: [],
          });
          break;
        }
        const batch = batches[index];
        const { parts, sourceLabels: batchLabels } = buildBatchSourceParts({
          note: input.note,
          sources: batch,
        });
        const batchTimeoutMs = Math.min(
          FILE_PARSE_OPENAI_TIMEOUT_MS,
          Math.max(FILE_PARSE_MIN_BATCH_TIMEOUT_MS, remainingMs - 5_000),
        );
        const batchRetries =
          FILE_PARSE_OPENAI_MAX_RETRIES > 0 &&
          remainingMs >
            batchTimeoutMs + FILE_PARSE_MIN_BATCH_TIMEOUT_MS + FILE_PARSE_BATCH_DELAY_MS
            ? FILE_PARSE_OPENAI_MAX_RETRIES
            : 0;
        try {
          const batchProposal = await requestProposalFromModel({
            condensedTrips,
            userParts: parts,
            source: "travel.ops.file_parse",
            timeoutMs: batchTimeoutMs,
            maxRetries: batchRetries,
            repairTimeoutMs: FILE_PARSE_REPAIR_TIMEOUT_MS,
            model: FILE_PARSE_MODEL,
            // Accuracy-first verify pass when there's budget left for the
            // extra call; otherwise skip it rather than risk a timeout.
            verify: remainingMs > batchTimeoutMs + FILE_PARSE_VERIFY_TIMEOUT_MS,
          });
          // Tag each conflict with the source filename so the admin knows
          // which file caused each question in the clarification UI.
          if (batches.length > 1 && batchProposal.conflicts.length > 0) {
            batchProposal.conflicts = batchProposal.conflicts.map((c) =>
              c.startsWith(`[${batchLabels}]`) ? c : `[${batchLabels}] ${c}`,
            );
          }
          proposals.push(batchProposal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const classification = classifyError(error);
          logError("travel.ai.file_batch_failed", {
            source: "travel.ops.file_parse",
            batchLabels,
            classification,
            message,
          });
          const rateLimited = classification.category === "rate_limited";
          proposals.push({
            summary: rateLimited
              ? `AI service is temporarily rate limited (429): ${batchLabels}`
              : `Could not finish reading batch: ${batchLabels}`,
            needs_confirmation: true,
            important_reason: rateLimited
              ? message
              : "One batch of uploaded files took too long or failed upstream, so the result may be incomplete.",
            conflicts: [`Нэг хэсгийг уншиж чадсангүй (${batchLabels}) — энэ хэсгийн аяллууд дутуу. Дахин оруулна уу.`],
            conflict_items: [{
              text: `Нэг хэсгийг уншиж чадсангүй (${batchLabels}) — энэ хэсгийн аяллууд дутуу. Дахин оруулна уу.`,
              severity: "blocker" as ConflictSeverity,
              type: "batch_failed",
            }],
            actions: [],
          });
        }
      }

      const merged = mergeBatchProposals(proposals, batches.length);

      // One trip = one action, even when it arrived as several poster slices.
      mergeDuplicateTripActions(merged);

      // Code-side completeness check: count numbered trip markers in source text
      // and warn if the model returned far fewer actions than expected.
      const allSourceText = sources
        .map((s) => s.contentText ?? "")
        .join("\n");
      if (allSourceText.trim()) {
        const numberedMatches = allSourceText.match(/(?:^|\n)\s*\d{1,2}[\.\)]/gm);
        const detectedCount = numberedMatches ? numberedMatches.length : 0;
        const actionCount = merged.actions.length;
        // Only warn when there's a clear gap: 3+ numbered items detected and
        // the model returned fewer than 70% of them.
        if (detectedCount >= 3 && actionCount < detectedCount * 0.7) {
          const missingCount = detectedCount - actionCount;
          const warningText = `${detectedCount} аялал илэрснээс ${actionCount}-г боловсруулсан, ${missingCount} аялал дутуу байна. Бүгдийг уншаагүй тул хадгалахаас өмнө шалгаж, дутуу аяллуудыг дахин оруулна уу.`;
          merged.needs_confirmation = true;
          if (!merged.conflicts.includes(warningText)) {
            merged.conflicts.unshift(warningText);
          }
          if (!merged.conflict_items) merged.conflict_items = [];
          if (!merged.conflict_items.some((ci) => ci.text === warningText)) {
            merged.conflict_items.unshift({
              text: warningText,
              severity: "blocker" as ConflictSeverity,
              type: "completeness_check",
            });
          }
        }
      }

      // Stamp each action's extra.source_file_attachment_id so the saved
      // trip record knows which FB reusable attachment to send customers.
      if (fbAttachmentMap.size > 0) {
        for (const action of merged.actions) {
          const sourceFile = (action.fields?.extra as Record<string, unknown> | undefined)?.source_file_name;
          if (typeof sourceFile === "string" && fbAttachmentMap.has(sourceFile)) {
            const extra = (action.fields?.extra as Record<string, unknown>) ?? {};
            extra.source_file_attachment_id = fbAttachmentMap.get(sourceFile);
            if (!action.fields) (action as { fields?: Record<string, unknown> }).fields = {};
            (action.fields as Record<string, unknown>).extra = extra;
          }
        }
      }

      if (photoUrlMap.size > 0 && merged.actions.length > 0) {
        attachPhotoUrlsToActions(photoUrlMap, merged);
      }
      // Persist the uploaded-image inventory on the proposal itself so a
      // clarification revision (which round-trips through the model) can
      // re-attach photos in code instead of trusting the model to keep them.
      if (photoUrlMap.size > 0) {
        merged.photo_sources = Array.from(photoUrlMap, ([label, urls]) => ({
          label,
          urls,
        }));
      }

      return merged;
    },
  });
}

/**
 * Photos are attached/restored deterministically in code (carryOverPhotoUrls
 * + photo_sources re-attach), so the model never needs the long Cloudinary
 * URLs — sending them just bloated the prompt and gave the model a chance to
 * mangle or drop them. Strip before stringifying.
 */
function proposalWithoutPhotoData(proposal: AIChangeProposal): AIChangeProposal {
  const clone = JSON.parse(JSON.stringify(proposal)) as AIChangeProposal;
  delete clone.photo_sources;
  for (const action of clone.actions) {
    if (action.fields && "photo_urls" in action.fields) {
      delete (action.fields as Record<string, unknown>).photo_urls;
    }
  }
  return clone;
}

function buildProposalRevisionGuide(input: {
  instruction: string;
  currentProposal: AIChangeProposal;
  clarification: string;
  condensedTrips: unknown;
}) {
  return [
    "You are revising an existing travel-ops proposal after a short admin clarification.",
    "Keep every action for a trip the clarification does not mention — never drop or rename unrelated actions.",
    "Return JSON only using the same schema as before.",
    "Keep high-confidence extracted data unless the clarification changes it.",
    "Resolve only the directly affected uncertainty. Do not invent missing facts.",
    "If the clarification clearly answers a conflict, remove that conflict from the output.",
    "If uncertainty still remains, keep needs_confirmation=true and keep only the unresolved conflicts.",
    "Any remaining conflict/question must be in plain, friendly Mongolian like a travel agent — never mention internal IDs or field names (no 'seed-33', 'trip_id', 'route_name', 'status='). Refer to trips by their quoted name.",
    "",
    "JSON schema:",
    "{",
    '  "summary": "short summary",',
    '  "needs_confirmation": true/false,',
    '  "important_reason": "why confirmation is still needed",',
    '  "conflicts": ["remaining conflict"],',
    '  "actions": [',
    '    { "action": "upsert|patch|cancel", "trip_id": "", "match": { "operator_name": "", "route_name": "" }, "fields": {} }',
    "  ]",
    "}",
    "",
    `Original admin request: ${input.instruction}`,
    `Admin clarification: ${input.clarification}`,
    `Current proposal JSON: ${JSON.stringify(proposalWithoutPhotoData(input.currentProposal))}`,
    `Current trips (JSON): ${JSON.stringify(input.condensedTrips)}`,
  ].join("\n");
}

export async function reviseAIRequest(
  requestId: number,
  clarification: string,
) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured." };
  }

  const reqResult = await queryNeon<{
    id: number;
    instruction: string;
    proposal_json: AIChangeProposal;
    status: string;
  }>(
    `
      SELECT id, instruction, proposal_json, status
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) {
    return { ok: false, message: "Change request not found." };
  }
  if (row.status === "applied") {
    return { ok: false, message: "Request is already applied." };
  }

  const currentProposal = normalizeProposal(row.proposal_json);
  const trips = await listTrips({ limit: 250 });
  const condensedTrips = trips.map((trip) => ({
    id: trip.id,
    category: trip.category,
    operator_name: trip.operator_name,
    route_name: trip.route_name,
    status: trip.status,
    seats_left: trip.seats_left,
    seats_total: trip.seats_total,
    has_food: trip.has_food,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    currency: trip.currency,
    duration_text: trip.duration_text,
    departure_dates: trip.departure_dates,
  }));

  const prompt = buildProposalRevisionGuide({
    instruction: row.instruction,
    currentProposal,
    clarification,
    condensedTrips,
  });

  const revisedProposal = await requestProposalFromPrompt({
    prompt,
    source: "travel.ops.ai_clarify",
    timeoutMs: 30_000,
    maxRetries: 0,
    repairTimeoutMs: 15_000,
  });

  // Photos are handled entirely in code: the model never saw the URLs
  // (proposalWithoutPhotoData), so restore them here. First by trip identity
  // from the pre-revision actions, then fuzzy filename-matching from the
  // persisted upload inventory (covers renamed trips the identity key misses).
  carryOverPhotoUrls(currentProposal, revisedProposal);
  const photoSources = currentProposal.photo_sources || [];
  if (photoSources.length > 0) {
    if (revisedProposal.actions.length > 0) {
      attachPhotoUrlsToActions(
        new Map(photoSources.map((s) => [s.label, s.urls])),
        revisedProposal,
        { quiet: true },
      );
    }
    // Keep the inventory alive for the next clarification round.
    revisedProposal.photo_sources = photoSources;
  }

  await queryNeon(
    `
      UPDATE travel_ai_change_requests
      SET
        proposal_json = $2::jsonb,
        conflicts = $3::text[],
        needs_confirmation = $4
      WHERE id = $1
    `,
    [
      requestId,
      JSON.stringify(revisedProposal),
      revisedProposal.conflicts,
      revisedProposal.needs_confirmation,
    ],
  );

  return {
    ok: true,
    proposal: revisedProposal,
    request_id: requestId,
    requires_confirmation: Boolean(revisedProposal.needs_confirmation),
  };
}

function fieldsWithMergedPhotoUrls(
  fields: AITripAction["fields"] | undefined,
  before: TravelTrip | null,
): AITripAction["fields"] {
  const next = { ...(fields || {}) };
  if (!Array.isArray(next.photo_urls) || next.photo_urls.length === 0) return next;
  const existing = Array.isArray(before?.photo_urls) ? before.photo_urls : [];
  next.photo_urls = Array.from(
    new Set(
      [...existing, ...next.photo_urls]
        .filter((url): url is string => typeof url === "string")
        .map((url) => url.trim())
        .filter((url) => url.startsWith("https://")),
    ),
  ).slice(0, 20);
  return next;
}

async function applyAIAction(action: AITripAction) {
  if (!action || typeof action !== "object") {
    return { ok: false, message: "Invalid action payload." };
  }

  const verb = String(action.action || "").trim().toLowerCase();
  if (!verb) return { ok: false, message: "Missing action verb." };

  if (verb === "upsert") {
    let targetId = action.trip_id?.trim() || "";
    if (!targetId && action.match) {
      const match = await resolveTripIdByMatch(action.match);
      if (
        match.conflict &&
        !/matching trip not found|таарах аялал олдсонгүй/i.test(match.conflict)
      ) {
        return { ok: false, message: match.conflict };
      }
      targetId = match.id || "";
    }
    const before = targetId ? await getTripById(targetId) : null;
    if (before) {
      const updated = await patchTrip(
        targetId,
        fieldsWithMergedPhotoUrls(action.fields, before) || {},
      );
      if (!updated) return { ok: false, message: "Existing trip update failed." };
      return {
        ok: true,
        message: `Шинэчилсэн: "${updated.route_name}"`,
        snapshot: {
          action: { ...action, action: "patch" },
          trip_id: updated.id,
          before,
          after: updated,
        } satisfies AIActionSnapshot,
      };
    }
    const updated = await upsertTrip({
      id: targetId || undefined,
      fields: action.fields || {},
    });
    if (!updated) return { ok: false, message: "Upsert failed." };
    return {
      ok: true,
      message: `Нэмсэн: "${updated.route_name}"`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  let targetId = action.trip_id?.trim() || "";
  if (!targetId) {
    const match = await resolveTripIdByMatch(action.match);
    if (match.conflict) return { ok: false, message: match.conflict };
    targetId = match.id || "";
  }
  if (!targetId) return { ok: false, message: "Target trip not found." };

  if (verb === "cancel") {
    const before = await getTripById(targetId);
    const updated = await patchTrip(targetId, {
      status: "cancelled",
      ...(action.fields || {}),
    });
    if (!updated) return { ok: false, message: "Cancel update failed." };
    return {
      ok: true,
      message: `Цуцалсан: "${updated.route_name}"`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  if (verb === "patch") {
    const before = await getTripById(targetId);
    const updated = await patchTrip(
      targetId,
      fieldsWithMergedPhotoUrls(action.fields, before) || {},
    );
    if (!updated) return { ok: false, message: "Patch update failed." };
    return {
      ok: true,
      message: `Шинэчилсэн: "${updated.route_name}"`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  return { ok: false, message: `Unsupported action: ${verb}` };
}

export async function applyAIRequest(requestId: number) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured." };
  }

  const reqResult = await queryNeon<{
    id: number;
    instruction: string;
    proposal_json: AIChangeProposal;
    needs_confirmation: boolean;
    status: string;
  }>(
    `
      SELECT id, instruction, proposal_json, needs_confirmation, status
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) return { ok: false, message: "Change request not found." };
  if (row.status === "applied") {
    return {
      ok: true,
      message: "Request already applied.",
      results: [] as string[],
      request_id: requestId,
    };
  }

  const proposal = normalizeProposal(row.proposal_json);
  attachPersistedPhotoSources(proposal);
  const trips = await listTrips({ limit: 250 });
  const validation = validateAIChangeProposal(proposal, trips, {
    forbidCreate: instructionForbidsTripCreation(row.instruction),
  });
  if (validation.blocking_conflicts.length > 0) {
    await queryNeon(
      `
        UPDATE travel_ai_change_requests
        SET
          proposal_json = $2::jsonb,
          conflicts = $3::text[],
          needs_confirmation = TRUE,
          status = 'error'
        WHERE id = $1
      `,
      [
        requestId,
        JSON.stringify(validation.proposal),
        validation.proposal.conflicts,
      ],
    );
    return {
      ok: false,
      message: "Proposal failed validation before saving.",
      results: validation.blocking_conflicts,
      proposal: validation.proposal,
    };
  }

  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of validation.proposal.actions) {
    const result = await applyAIAction(action);
    results.push(result.message);
    if (result.ok && result.snapshot) snapshots.push(result.snapshot);
    if (!result.ok) failed = true;
  }

  const status = failed ? "error" : "applied";
  await queryNeon(
    `
      UPDATE travel_ai_change_requests
      SET
        status = $2,
        rollback_json = $3::jsonb,
        applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE NULL END,
        reverted_at = NULL
      WHERE id = $1
    `,
    [requestId, status, JSON.stringify(snapshots)],
  );

  return {
    ok: !failed,
    message: failed
      ? "Some actions failed. Review results."
      : "All actions applied successfully.",
    results,
    proposal: validation.proposal,
    request_id: requestId,
  };
}

export async function applyAIProposalDirect(
  proposal: AIChangeProposal,
  instruction: string,
) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured.", results: [] as string[] };
  }

  const trips = await listTrips({ limit: 250 });
  attachPersistedPhotoSources(proposal);
  const validation = validateAIChangeProposal(proposal, trips, {
    forbidCreate: instructionForbidsTripCreation(instruction),
  });
  const normalised = validation.proposal;
  if (validation.blocking_conflicts.length > 0) {
    return {
      ok: false,
      message: "Proposal failed validation before saving.",
      results: validation.blocking_conflicts,
      proposal: normalised,
    };
  }
  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of normalised.actions) {
    const result = await applyAIAction(action);
    results.push(result.message);
    if (result.ok && result.snapshot) snapshots.push(result.snapshot);
    if (!result.ok) failed = true;
  }

  const status = failed ? "error" : "applied";
  let insertedRequestId: number | null = null;
  try {
    const inserted = await queryNeon<{ id: number }>(
      `
        INSERT INTO travel_ai_change_requests (
          instruction, proposal_json, conflicts, needs_confirmation, status, applied_at, rollback_json
        )
        VALUES ($1, $2::jsonb, $3::text[], $4, $5, CASE WHEN $5 = 'applied' THEN NOW() ELSE NULL END, $6::jsonb)
        RETURNING id
      `,
      [
        instruction,
        JSON.stringify(normalised),
        normalised.conflicts,
        normalised.needs_confirmation,
        status,
        JSON.stringify(snapshots),
      ],
    );
    insertedRequestId = inserted?.rows?.[0]?.id ?? null;
  } catch (insertError) {
    logError("travel.ai.direct_apply_insert_failed", {
      message:
        insertError instanceof Error ? insertError.message : String(insertError),
    });
  }

  return {
    ok: !failed,
    message: failed
      ? "Some actions failed. Review results."
      : "All actions applied successfully.",
    results,
    proposal: normalised,
    request_id: insertedRequestId,
  };
}

function normalizeActionSnapshots(value: unknown): AIActionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Partial<AIActionSnapshot>;
      const tripId = String(entry.trip_id || "").trim();
      if (!tripId) return null;
      return {
        action:
          entry.action && typeof entry.action === "object"
            ? (entry.action as AITripAction)
            : { action: "unknown" },
        trip_id: tripId,
        before: entry.before
          ? mapTripRow(entry.before as unknown as Record<string, unknown>)
          : null,
        after: entry.after
          ? mapTripRow(entry.after as unknown as Record<string, unknown>)
          : null,
      };
    })
    .filter((item): item is AIActionSnapshot => Boolean(item));
}

export async function rollbackAIRequest(requestId: number) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured.", results: [] as string[] };
  }

  const reqResult = await queryNeon<{
    id: number;
    status: string;
    rollback_json: unknown;
  }>(
    `
      SELECT id, status, rollback_json
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) {
    return { ok: false, message: "Change request not found.", results: [] as string[] };
  }
  if (row.status === "reverted") {
    return { ok: true, message: "Request is already rolled back.", results: [] as string[] };
  }

  const snapshots = normalizeActionSnapshots(row.rollback_json);
  if (snapshots.length === 0) {
    return {
      ok: false,
      message: "No rollback snapshot is available for this request.",
      results: [] as string[],
    };
  }

  const results: string[] = [];
  let failed = false;

  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.before) {
      const restored = await upsertTrip({
        id: snapshot.trip_id,
        fields: snapshot.before,
      });
      if (restored) {
        results.push(`Restored ${snapshot.trip_id}`);
      } else {
        failed = true;
        results.push(`Failed to restore ${snapshot.trip_id}`);
      }
      continue;
    }

    const deleted = await deleteTrip(snapshot.trip_id);
    if (deleted) {
      results.push(`Removed AI-created trip ${snapshot.trip_id}`);
    } else {
      results.push(`AI-created trip ${snapshot.trip_id} was already absent`);
    }
  }

  if (!failed) {
    await queryNeon(
      `
        UPDATE travel_ai_change_requests
        SET status = 'reverted', reverted_at = NOW()
        WHERE id = $1
      `,
      [requestId],
    );
  }

  return {
    ok: !failed,
    message: failed
      ? "Rollback finished with errors. Review results."
      : "Rollback completed successfully.",
    results,
  };
}
