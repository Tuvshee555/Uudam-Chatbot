import { MAX_TRIP_PHOTOS } from "./tripPhotoEdit";
import { aiCallFailureKind, askOpenAIParts, type OpenAIPart } from "./openaiProvider";
import {
  classifyError,
  logError,
  logInfo,
  logWarn,
  recordCounter,
} from "./observability";
import { queryNeon } from "./neonDb";
import type { AITripAction, ConflictSeverity, ConflictItem, AIChangeProposal, TravelTrip } from "./travelTypes";
import { AI_BILLING_FAILURE_SUMMARY, AI_KEY_FAILURE_SUMMARY, wait, ensureTravelSchema, listTrips, normalizeProposal, parseJsonFromModel, proposalFallbackFromRawText, dedupeStrings, estimateInlineBytes } from "./travelDb";
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
import { buildExtractionGuidance, buildInstructionGuide, buildProposalGuide, buildProposalRepairGuide } from "./travelAIGuides";
import { applyTripChoice, bindActionTargets, hasOpenQuestions, knownDepartureDays } from "./assistantBrain";
import { houseRulesPrompt } from "./assistantHouseRules";

type ProposalSource = {
  label: string;
  contentText?: string;
  inline?: { mimeType: string; data: string } | null;
  fbAttachmentId?: string;
  photoUrls?: string[];
};

import { applyPriceAnswer, applyTransportChoice, carryOverPhotoExtras, finalizeNewTripActions, newTripActions } from "./tripProposalFinalize";
import { liftDayStates, withPricedDaysOnCalendar, withRowYearsOfCalendar } from "./tripDayStates";
import { cleanRowHotels, settleRowInfantFares } from "./tripRowFares";
import { applyPriceTable, readPriceTable, type PriceTable } from "./tripPriceTable";

function buildBatchSourceParts(input: {
  note?: string;
  sources: ProposalSource[];
}) {
  const parts: OpenAIPart[] = [];
  const sourceLabels = input.sources.map((source) => source.label).join(", ");
  const guidance = buildExtractionGuidance(sourceLabels, input.note);
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

/**
 * A file that carries a whole day-by-day program is a NEW trip, whatever existing trip it
 * resembles (owner's rule, 2026-10-31: "add trip" never revives or edits a same-name trip).
 * The model read such a file as an edit of the live trip it matched, and saving it would
 * have overwritten that trip's program, hotel wording and photos (seen 2026-11-05). A price
 * list without a program still updates the trips it names.
 */
const ADD_OR_UPDATE_QUESTION = /шинэ аялал болгон нэмэх үү|одоо байгааг шинэчлэх үү/i;

export function keepFileProgramsNew(proposal: AIChangeProposal): void {
  let programs = 0;
  for (const action of proposal.actions) {
    const fields = action.fields as Record<string, unknown> | undefined;
    const days = (fields?.extra as Record<string, unknown> | undefined)?.itinerary_days;
    if (!Array.isArray(days) || days.length < 2 || action.action === "cancel") continue;
    if (typeof fields?.route_name !== "string" || !fields.route_name.trim()) continue;
    action.action = "upsert";
    delete action.trip_id;
    delete action.match;
    programs += 1;
  }
  // The model's own "add as new or update the existing one?" is already answered for these.
  if (programs > 0 && programs === proposal.actions.length) {
    proposal.conflict_items = (proposal.conflict_items || []).filter((item) => item.type !== "duplicate_route" && !ADD_OR_UPDATE_QUESTION.test(item.text));
    proposal.conflicts = (proposal.conflicts || []).filter((item) => !ADD_OR_UPDATE_QUESTION.test(item));
  }
}

const SAME_TRIP_MAX_SOURCES = 6;
const SAME_TRIP_NOTE = [
  "These sources together describe ONE trip: the document is its day-by-day program, and each image is that same trip's departure schedule and price table (or its poster).",
  "Return exactly one action for it. Take the name, days, meals, hotels and conditions from the document; take every departure date and the tugrug selling prices per date from the image (fields.departure_dates and fields.extra.departure_date_groups), and the year the image states.",
  "A column of yuan or land prices in the image is the partner's cost and is left out; the tugrug 'зарах / зарлах үнэ' columns are the selling prices.",
  "Read the price table row by row: one departure_date_groups entry per row, each with that row's own adult price and every child column of that row.",
].join(" ");

// Max chars per individual OpenAI call for text-only sources. JSON-mode
// structured extraction can be slow, so keep each call small.
const MAX_TEXT_CHARS_PER_BATCH = 18_000;
// Max numbered trips per chunk. Even a small char count can hold many trips,
// and emitting many trip JSON objects (with full extra metadata) in one call
// blows past the 45s timeout. 4 keeps each OpenAI call fast (~15-20s).
const MAX_TRIPS_PER_CHUNK = 4;

/** Counts numbered-heading lines ("1.", "2.", "12)") in the text. */
/**
 * Numbered lines that start a trip block ("1. ХАЙНАН…"). A numbered TABLE row ("1. | Дүүрсэн | 12 сарын 11 | …")
 * is one departure of the same trip, never a new trip: counting those split one partner page into half-trips.
 */
function tripHeadingLines(text: string): number[] {
  return [...text.matchAll(/(^|\n)[ \t]*\d{1,2}[.)][^\n]*/g)]
    .filter((match) => !match[0].includes("|"))
    .map((match) => (match.index ?? 0) + match[1].length);
}

function countNumberedTrips(text: string): number {
  return tripHeadingLines(text).length;
}

function sourceDigits(text: string): string {
  return text.replace(/[^\d]/g, "");
}

function numericValueAppearsInSource(value: number, text: string): boolean {
  if (!Number.isFinite(value)) return true;
  const digits = String(Math.trunc(Math.abs(value)));
  if (!digits || digits === "0") return true;
  return sourceDigits(text).includes(digits);
}

function pushSourceEvidenceBlocker(proposal: AIChangeProposal, text: string): void {
  proposal.needs_confirmation = true;
  if (!proposal.conflicts.includes(text)) proposal.conflicts.unshift(text);
  proposal.conflict_items = proposal.conflict_items || [];
  if (!proposal.conflict_items.some((item) => item.text === text)) {
    proposal.conflict_items.unshift({
      text,
      severity: "blocker" as ConflictSeverity,
      type: "source_evidence_missing",
    });
  }
}

function isPriceOrSeatKey(key: string): boolean {
  return /price|fare|fee|seat|суудал|үнэ/i.test(key);
}

function removeUnsupportedNestedNumbers(
  value: unknown,
  sourceText: string,
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => removeUnsupportedNestedNumbers(item, sourceText))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "number" &&
      isPriceOrSeatKey(key) &&
      !numericValueAppearsInSource(child, sourceText)
    ) {
      continue;
    }
    const cleaned = removeUnsupportedNestedNumbers(child, sourceText);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function stripUnsupportedExplicitYears(dates: string[], sourceText: string): string[] {
  const sourceYears = new Set(
    Array.from(sourceText.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)).map((match) => match[1]),
  );
  return dates.map((date) => {
    const text = String(date || "").trim();
    const iso = text.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (iso && !sourceYears.has(iso[1])) {
      return `${Number(iso[2])} сарын ${Number(iso[3])}`;
    }
    const mongolian = text.match(/^(20\d{2})\s*оны\s*(\d{1,2})\s*сарын\s*(\d{1,2})/i);
    if (mongolian && !sourceYears.has(mongolian[1])) {
      return `${Number(mongolian[2])} сарын ${Number(mongolian[3])}`;
    }
    return text;
  });
}

function sourceTextForAction(
  action: AITripAction,
  textByLabel: Map<string, string>,
  allText: string,
): string {
  const extra = action.fields?.extra as Record<string, unknown> | undefined;
  const label = typeof extra?.source_file_name === "string" ? extra.source_file_name.trim() : "";
  if (label && textByLabel.has(label)) return textByLabel.get(label) || "";
  if (textByLabel.size === 1) return Array.from(textByLabel.values())[0] || "";
  return allText;
}

export function enforceTextSourceEvidence(
  proposal: AIChangeProposal,
  sources: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
  }>,
): AIChangeProposal {
  const textSources = sources.filter((source) => source.contentText?.trim() && !source.inline);
  if (textSources.length === 0 || proposal.actions.length === 0) return proposal;

  const textByLabel = new Map(
    textSources.map((source) => [source.label, source.contentText?.trim() || ""]),
  );
  const allText = textSources.map((source) => source.contentText || "").join("\n\n");

  for (const action of proposal.actions) {
    const fields = action.fields as Record<string, unknown> | undefined;
    if (!fields) continue;
    const evidence = sourceTextForAction(action, textByLabel, allText);
    if (!evidence.trim()) continue;
    const label = fields.route_name?.toString().trim() || action.match?.route_name || "Аялал";

    for (const key of ["adult_price", "child_price", "infant_price", "seats_total", "seats_left"]) {
      const value = fields[key];
      if (typeof value !== "number" || numericValueAppearsInSource(value, evidence)) continue;
      delete fields[key];
      const fieldLabel = key.includes("price") ? "үнэ" : "суудлын тоо";
      pushSourceEvidenceBlocker(
        proposal,
        `${label}: AI ${fieldLabel} ${value} гэж санал болгосон боловч эх файлд энэ тоо олдсонгүй. Файлын үнийг/суудлыг гараар шалгана уу.`,
      );
    }

    if (Array.isArray(fields.departure_dates)) {
      const before = fields.departure_dates.map((date) => String(date || "").trim()).filter(Boolean);
      const after = stripUnsupportedExplicitYears(before, evidence);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        fields.departure_dates = after;
        pushSourceEvidenceBlocker(
          proposal,
          `${label}: эх файлд жил бичигдээгүй байхад AI гарах огноонд жил нэмсэн тул жилийг хаслаа. Яг аль жил болохыг баталгаажуулна уу.`,
        );
      }
    }

    if (fields.extra && typeof fields.extra === "object") {
      fields.extra = removeUnsupportedNestedNumbers(fields.extra, evidence);
    }
  }

  return proposal;
}

/**
 * Splits a plain-text string into chunks at numbered-trip boundaries
 * ("1.", "2." …). Each chunk holds at most MAX_TRIPS_PER_CHUNK trips and
 * stays under maxChars. Falls back to hard char slicing if no boundaries.
 */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  // Collect positions of numbered headings (each starts a new trip block)
  const positions: number[] = [0];
  for (const pos of tripHeadingLines(text)) {
    if (pos > 0 && pos - positions[positions.length - 1] > 100) positions.push(pos);
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
    // One web page is one source (readWebPage caps it at 20,000 characters): cut in two, each half was read
    // as its own trip with part of the schedule (2026-11-11).
    const webPage = /^https?:\/\//i.test(source.label.trim());
    const needsSplit =
      !source.inline && !webPage &&
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
    "  mismatches naming the trip and the wrong field (e.g. '<аялал>: үнэ 1111111 гэж",
    "  байгаа ч зурагт 2222222 байна').",
    "- CRITICAL: before reporting a mismatch, compare the two values as NUMBERS/DATES,",
    "  ignoring commas, currency symbols (₮, MNT), and whitespace. '1,111,111' and",
    "  '1,111,111₮' are THE SAME VALUE — do not report that as a mismatch. Only report",
    "  a mismatch when the underlying number, date, or text is actually different.",
    "- If a value in the source is genuinely unreadable, list it as a mismatch too.",
    "- If everything matches exactly, return all_correct=true and mismatches=[].",
    "- Do NOT invent trips or add new data. Only verify what is given.",
  ].join("\n");
}

/**
 * Safety net for the verifier itself: despite the prompt instruction, the
 * model sometimes reports a "mismatch" where both quoted values are actually
 * identical once you strip formatting — e.g. "үнэ 1,111,111 гэж байгаа ч
 * зурагт 1,111,111₮ байна" (synthetic amounts; currency symbol only) or the
 * same date range
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

// A typed instruction is one short JSON extraction over an 8k-token guide that is mostly the
// same every call: gpt-4.1 (cheaper input and cached-input than gpt-4o, same family as the
// customer replies) since 2026-11-05. OPENAI_INSTRUCTION_MODEL overrides.
const OPENAI_INSTRUCTION_MODEL = process.env.OPENAI_INSTRUCTION_MODEL || "gpt-4.1";

async function requestProposalFromModel(opts: {
  condensedTrips: unknown;
  userParts: OpenAIPart[];
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  model?: string;
  verify?: boolean;
  /** A typed instruction: the guide adds the house rules and the trips it most likely concerns. */
  instruction?: { focusTrips: unknown[] };
}) {
  // OpenAI handles all proposal extraction (file parsing + text instructions).
  // PDF inputs are rendered/extracted before reaching this path.
  const guide = opts.instruction
    ? buildInstructionGuide(opts.condensedTrips, { focusTrips: opts.instruction.focusTrips, houseRules: houseRulesPrompt() })
    : buildProposalGuide(opts.condensedTrips);
  const result = await askOpenAIParts(
    [{ text: guide }, ...opts.userParts],
    {
      source: opts.source,
      jsonMode: true,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      model: opts.model,
      preferOpenAI: true,
      openaiModel: opts.instruction ? OPENAI_INSTRUCTION_MODEL : OPENAI_FILE_PARSE_MODEL,
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
          openaiModel: opts.instruction ? OPENAI_INSTRUCTION_MODEL : OPENAI_FILE_PARSE_MODEL,
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

/** One trip as the model should see it when an instruction is about it: every fact it may need. */
export function focusTripDetail(trip: TravelTrip, now = new Date()) {
  const groups = Array.isArray(trip.extra?.price_groups) ? (trip.extra.price_groups as unknown[]) : [];
  const row = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  return {
    id: trip.id,
    route_name: trip.route_name,
    aliases: Array.isArray(trip.extra?.aliases) ? trip.extra.aliases : [],
    status: trip.status,
    duration_text: trip.duration_text,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    infant_price: trip.infant_price,
    currency: trip.currency,
    departure_dates: trip.departure_dates,
    departure_days: knownDepartureDays(trip, now).map((day) => ({ date: day.date, state: day.state ?? "not_on_website" })),
    price_rows: groups.slice(0, 24).map((group) => {
      const value = row(group);
      return { label: value.label, dates: value.dates, adult_price: value.adult_price, child_price: value.child_price, infant_price: value.infant_price,
        passengers: Array.isArray(value.passenger_prices) ? value.passenger_prices.map((tier) => { const t = row(tier); return { label: t.label, age_range: t.age_range, price: t.price }; }) : [] };
    }),
    seats_total: trip.seats_total,
    seats_left: trip.seats_left,
    has_food: trip.has_food,
    hotel: trip.hotel,
    transport_type: trip.extra?.transport_type ?? null,
    notes: String(trip.notes || "").slice(0, 600),
  };
}

/**
 * The change request's id as a number. The column is BIGSERIAL and the driver returns
 * bigints as strings, so the admin page (which checks `typeof === "number"`) saw no id at
 * all: every proposal was applied as a one-off copy, a pending row was left behind each
 * time, and the Буцаах (rollback) button never appeared (live run, 2026-11-05).
 */
export function changeRequestId(row: { id?: unknown } | null | undefined): number | null {
  const id = Number(row?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Saves a proposal built in code (the brain, a quick action) as a change request, so it
 * can be applied, revised and rolled back like a model proposal.
 */
export async function persistProposal(instruction: string, proposal: AIChangeProposal): Promise<number | null> {
  try {
    const inserted = await queryNeon<{ id: number }>(
      `INSERT INTO travel_ai_change_requests (instruction, proposal_json, conflicts, needs_confirmation, status)
       VALUES ($1, $2::jsonb, $3::text[], $4, 'pending') RETURNING id`,
      [instruction, JSON.stringify(proposal), proposal.conflicts || [], proposal.needs_confirmation],
    );
    return changeRequestId(inserted?.rows?.[0]);
  } catch (error) {
    logError("travel.ai.proposal_insert_failed", { source: "assistant.brain", message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function createProposal(opts: {
  instruction: string;
  source: string;
  userParts?: OpenAIPart[];
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  buildProposal?: (condensedTrips: unknown) => Promise<AIChangeProposal>;
  /** The catalogue as already read by the caller (saves a second read). */
  trips?: TravelTrip[];
  /** A typed instruction: which trips it most likely concerns, for the model's guide. */
  focusTrips?: TravelTrip[];
  /** Runs on the validated proposal, before it is stored. */
  afterValidation?: (proposal: AIChangeProposal, trips: TravelTrip[]) => AIChangeProposal;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { proposal: normalizeProposal(null), request_id: null };
  }

  const trips = opts.trips ?? await listTrips({ limit: 250, includeArchived: true });
  const tripsInCreatedOrder = [...trips].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  let unnamedOrder = 0;
  const instructionMode = opts.focusTrips !== undefined;
  const condensedTrips = instructionMode
    // The guide carries the likely trips in full; the rest of the catalogue only has to be findable by name.
    ? tripsInCreatedOrder.map((trip) => ({ id: trip.id, route_name: trip.route_name, status: trip.status, next_departure: trip.departure_dates[0] ?? null }))
    : tripsInCreatedOrder.map((trip) => ({
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
          ...(instructionMode ? { instruction: { focusTrips: (opts.focusTrips || []).map((trip) => focusTripDetail(trip)) } } : {}),
        }),
      );
    }
    // An action that names its trip instead of identifying it is resolved the way the admin's
    // own words are: one clear trip binds it, several become a question with choices.
    bindActionTargets(proposal, trips);
    stampTripVersions(proposal, trips);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyError(error);
    logWarn("travel.ai.proposal_failed", {
      source: opts.source,
      classification,
      message,
    });
    // Surface the real reason instead of a misleading "couldn't parse JSON". An empty
    // balance and a rejected key are not "temporarily rate limited": nothing will work
    // until the owner acts, and the admin must be told that (2026-11-04).
    const failureKind = aiCallFailureKind(error);
    const rateLimited = classification.category === "rate_limited" || failureKind === "quota";
    const timedOut = classification.category === "timeout";
    const circuitOpen = classification.category === "circuit_open";
    const failureSummary = failureKind === "credits_exhausted"
      ? AI_BILLING_FAILURE_SUMMARY
      : failureKind === "unauthorized"
        ? AI_KEY_FAILURE_SUMMARY
        : rateLimited
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
  if (opts.afterValidation) proposal = opts.afterValidation(proposal, trips);
  // After validation (which rewrites dates and rows): every priced day on the calendar and each
  // day's seat state held per day for the review (tripDayStates.ts).
  for (const action of newTripActions(proposal)) {
    const fields = action.fields as Record<string, unknown>;
    const scheduled = liftDayStates(withPricedDaysOnCalendar(withRowYearsOfCalendar(settleRowInfantFares(cleanRowHotels(fields)))));
    if (scheduled !== fields) Object.assign(fields, { departure_dates: scheduled.departure_dates, infant_price: scheduled.infant_price, extra: scheduled.extra });
  }

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
    request_id: changeRequestId(inserted?.rows?.[0]),
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

export async function generateAIProposal(instruction: string, options?: { context?: string; trips?: TravelTrip[]; focusTrips?: TravelTrip[] }) {
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
    trips: options?.trips,
    focusTrips: options?.focusTrips ?? [],
    userParts: [{ text: options?.context
      ? `Өмнөх яриа (зөвхөн ойлгоход; одоогийн хүсэлтийг биелүүл):
${options.context}

Хэрэглэгчийн хүсэлт: ${instruction}`
      : `Хэрэглэгчийн хүсэлт: ${instruction}` }],
    source: "travel.ops.ai_change",
    timeoutMs: AI_CHANGE_OPENAI_TIMEOUT_MS,
    maxRetries: AI_CHANGE_OPENAI_MAX_RETRIES,
    repairTimeoutMs: AI_CHANGE_REPAIR_TIMEOUT_MS,
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
      // Prefer the MORE SPECIFIC name ("<хот> арлын аялал 2026" over "<хот>
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
 * trailing detail ("<хот> арлын аялал 2026" vs "<хот> арлын аялал"). When one
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
  // trip names (<хот> АЯЛАЛ) and silently failed the 60% match bar.
  "compressed", "converted", "resized", "scaled", "optimized", "edited",
]);

function photoMatchTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/э/g, "е") // fold Mongolian е/э spelling variance (<хот> vs Жанжиажие)
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
    ).slice(0, MAX_TRIP_PHOTOS);
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
    //    — so "<хот> ... <хот> <хот>.zip" can't latch onto the
    //    separate "<хот> - <хот> - <хот>" trip on partial overlap.
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

export function attachPersistedPhotoSources(proposal: AIChangeProposal): void {
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
  /**
   * The sources are one trip seen from several sides: a Word program and the picture of
   * its departure and price table. They are read in one model call, as one trip, and what
   * is read from the picture is not checked against the document's text.
   */
  sameTrip?: boolean;
  /** Runs on the validated proposal before it is stored (a web page's reading may only add trips). */
  afterValidation?: (proposal: AIChangeProposal, trips: TravelTrip[]) => AIChangeProposal;
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
  const sameTrip = Boolean(input.sameTrip) && sources.length > 1 && sources.length <= SAME_TRIP_MAX_SOURCES;
  const batches = sameTrip ? [sources] : chunkProposalSources(sources);
  const batchNote = sameTrip ? [input.note, SAME_TRIP_NOTE].filter(Boolean).join("\n") : input.note;

  return createProposal({
    instruction: input.note
      ? `[File] ${sourceLabels} - ${input.note}`
      : `[File] ${sourceLabels}`,
    source: "travel.ops.file_parse",
    afterValidation: input.afterValidation,
    buildProposal: async (condensedTrips) => {
      const proposals: AIChangeProposal[] = [];
      const startedAt = Date.now();
      // The price picture beside a program is read on its own, row by row, while the
      // program is being read (tripPriceTable.ts).
      const tableReads = sameTrip
        ? Promise.all(sources.filter((source) => source.inline?.mimeType.startsWith("image/")).map((source) => readPriceTable(source.inline!)))
        : null;

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
          note: batchNote,
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
          const failureKind = aiCallFailureKind(error);
          const rateLimited = classification.category === "rate_limited" || failureKind === "quota";
          proposals.push({
            summary: failureKind === "credits_exhausted"
              ? `${AI_BILLING_FAILURE_SUMMARY} (${batchLabels})`
              : failureKind === "unauthorized"
                ? `${AI_KEY_FAILURE_SUMMARY} (${batchLabels})`
                : rateLimited
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

      keepFileProgramsNew(merged);
      // One trip = one action, even when it arrived as several poster slices.
      mergeDuplicateTripActions(merged);
      // A price or a year read from the picture is not in the document's text; the guard
      // would delete it as invented (it did, on a real program + price table, 2026-11-05).
      if (!sameTrip) enforceTextSourceEvidence(merged, sources);
      if (tableReads) {
        const tables = (await tableReads).filter((table): table is PriceTable => Boolean(table));
        const created = newTripActions(merged);
        if (tables.length && created.length === 1) {
          const table: PriceTable = { year: tables.find((entry) => entry.year)?.year ?? null, rows: tables.flatMap((entry) => entry.rows) };
          applyPriceTable(created[0].fields as Record<string, unknown>, table);
        }
      }

      // Code-side completeness check: count numbered trip markers in source text
      // and warn if the model returned far fewer actions than expected.
      const allSourceText = sources
        .map((s) => s.contentText ?? "")
        .join("\n");
      if (allSourceText.trim()) {
        // Numbered itinerary days and numbered table rows are not tours. Only
        // use explicit trip/tour-labelled markers for this safety check.
        const numberedMatches = allSourceText.match(
          /(?:^|\n)\s*(?:аялал|trip|tour)\s*(?:#|№|no\.?\s*)?\d{1,2}\s*[\.\):\-]?/gimu,
        );
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
      // Standard Ulaanbaatar days, transport tags, the transport choice and the
      // missing photos — what makes a file-created trip equal to one added on the web.
      // The photo search only gets the time the batches left of the route's budget.
      const remainingMs = FILE_PARSE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
      await finalizeNewTripActions(merged, { photos: remainingMs > 25_000 ? { budgetMs: remainingMs - 15_000 } : undefined, sourceText: allSourceText });

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
    '    { "action": "upsert|patch|cancel|delete|set_date_state", "trip_id": "", "match": { "operator_name": "", "route_name": "" }, "fields": {}, "date": "YYYY-MM-DD (set_date_state)", "state": "open|low|full|paused (set_date_state)", "expected_updated_at": "keep as given" }',
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
  const trips = await listTrips({ limit: 250, includeArchived: true });

  // A tapped trip answers its question in code. When nothing else is open, the proposal is
  // complete as it stands and the model is not asked to "revise" what it never got wrong.
  if (applyTripChoice(clarification, currentProposal, trips) && !hasOpenQuestions(currentProposal)) {
    const settled = validateAIChangeProposal(currentProposal, trips, {
      forbidCreate: instructionForbidsTripCreation(row.instruction),
    }).proposal;
    settled.photo_sources = currentProposal.photo_sources;
    await queryNeon(
      `UPDATE travel_ai_change_requests SET proposal_json = $2::jsonb, conflicts = $3::text[], needs_confirmation = $4 WHERE id = $1`,
      [requestId, JSON.stringify(settled), settled.conflicts, settled.needs_confirmation],
    );
    return { ok: true, proposal: settled, request_id: requestId, requires_confirmation: Boolean(settled.needs_confirmation) };
  }

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
  // A clicked transport type rebuilds the standard days; found photos and their
  // credits are kept, never searched for a second time.
  applyTransportChoice(clarification, revisedProposal);
  // The tugrug price the admin typed into the price question wins over the model's reading.
  applyPriceAnswer(clarification, revisedProposal);
  carryOverPhotoExtras(currentProposal, revisedProposal);
  await finalizeNewTripActions(revisedProposal);
  // A revised proposal is checked like a new one (B9): names bound to real trips, versions
  // stamped, validated — never stored as the model wrote it.
  bindActionTargets(revisedProposal, trips);
  stampTripVersions(revisedProposal, trips);
  const checked = validateAIChangeProposal(revisedProposal, trips, { forbidCreate: instructionForbidsTripCreation(row.instruction) }).proposal;
  if (revisedProposal.photo_sources) checked.photo_sources = revisedProposal.photo_sources;
  Object.assign(revisedProposal, checked);

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


/**
 * A model action on an existing trip remembers the trip version the prompt was built from, as
 * the brain's own actions do, so apply can refuse it once the trip has moved on.
 */
function stampTripVersions(proposal: AIChangeProposal, trips: TravelTrip[]): void {
  const versions = new Map(trips.map((trip) => [trip.id, trip.updated_at]));
  for (const action of proposal.actions) {
    const verb = String(action.action || "").toLowerCase();
    if (!action.trip_id || action.expected_updated_at || (verb !== "patch" && verb !== "cancel" && verb !== "delete")) continue;
    const version = versions.get(action.trip_id);
    if (version) action.expected_updated_at = version;
  }
}
