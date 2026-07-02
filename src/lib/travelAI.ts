import { askGeminiParts, type GeminiPart } from "./gemini";
import {
  classifyError,
  logError,
  logInfo,
  logWarn,
  recordCounter,
} from "./observability";
import { queryNeon } from "./neonDb";
import type {
  AITripAction,
  ConflictSeverity,
  ConflictItem,
  AIChangeProposal,
  ProposalValidationReport,
} from "./travelTypes";
import {
  wait,
  ensureTravelSchema,
  listTrips,
  getTripById,
  upsertTrip,
  patchTrip,
  deleteTrip,
  resolveTripIdByMatch,
  mapTripRow,
  normalizeProposal,
  parseJsonFromModel,
  proposalFallbackFromRawText,
  dedupeStrings,
  cleanFields,
  isAgencyHeaderName,
  isAgencyHeaderConflict,
  isOptionalAddOnCostConflict,
  isDocumentedMealExceptionConflict,
  isGenericConfirmationText,
  isCompleteCleanAction,
  buildConflictLabel,
  findTripMatches,
  isReasonableMoney,
  isReasonableSeats,
  normalizeDateText,
  isRecurringDepartureText,
  estimateInlineBytes,
} from "./travelDb";
import type { TravelTrip } from "./travelTypes";
import {
  AI_CHANGE_GEMINI_TIMEOUT_MS,
  AI_CHANGE_GEMINI_MAX_RETRIES,
  AI_CHANGE_REPAIR_TIMEOUT_MS,
  FILE_PARSE_MODEL,
  OPENAI_FILE_PARSE_MODEL,
  FILE_PARSE_VERIFY,
  FILE_PARSE_VERIFY_TIMEOUT_MS,
  FILE_PARSE_GEMINI_TIMEOUT_MS,
  FILE_PARSE_GEMINI_MAX_RETRIES,
  FILE_PARSE_BATCH_DELAY_MS,
  FILE_PARSE_TOTAL_BUDGET_MS,
  FILE_PARSE_MIN_BATCH_TIMEOUT_MS,
  FILE_PARSE_REPAIR_TIMEOUT_MS,
} from "./travelDb";

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

export function instructionForbidsTripCreation(instruction: string): boolean {
  const text = instruction.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  const explicitNoCreate =
    /(?:do\s*not|don't|dont|never)\s+(?:try\s+to\s+)?(?:add|create)(?:\s+(?:new\s+)?trips?)?/.test(text) ||
    /(?:шинэ\s+аялал\s+)?(?:бүү|битгий)\s+(?:нэм|үүсгэ)/.test(text) ||
    // Must be paired with "аялал" or "шинэ" — bare "нэмэхгүй" matches too many
    // unrelated phrases like "суудлыг 0 болгохгүй" or error messages in prior context
    /(?:шинэ\s+аялал|аялал)\s+(?:нэмэхгүй|үүсгэхгүй)/.test(text) ||
    /(?:нэмэхгүй|үүсгэхгүй)\s+(?:гэсэн|тул|гэж)/.test(text);
  const updateOnly =
    /(?:only|just)\s+(?:update|fill|rename|add\s+(?:the\s+)?names?)/.test(text) ||
    /зөвхөн[^.]{0,80}(?:нэр|нөх|шинэчил|зас)/.test(text);
  return explicitNoCreate || updateOnly;
}

function isMissingTripName(value: string | undefined): boolean {
  const name = String(value || "").trim();
  return !name || /^\(?\s*нэргүй\s+аялал\s*\)?$/i.test(name);
}

function isResolvedMissingDateConflict(
  conflict: string,
  actions: AITripAction[],
): boolean {
  const normalized = conflict.toLowerCase();
  const claimsMissingDate =
    (normalized.includes("огноо") || normalized.includes("гарах өдөр") || normalized.includes("departure date")) &&
    (normalized.includes("тодорхойгүй") || normalized.includes("алга") || normalized.includes("missing") || normalized.includes("unknown"));
  if (!claimsMissingDate) return false;

  const datedActions = actions.filter(
    (action) =>
      Array.isArray(action.fields?.departure_dates) &&
      action.fields.departure_dates.some((date) => String(date).trim().length > 0),
  );
  if (datedActions.length === 0) return false;
  if (datedActions.length === actions.length) return true;
  return datedActions.some((action) => {
    const route = String(action.fields?.route_name || action.match?.route_name || "")
      .trim()
      .toLowerCase();
    return route.length > 2 && normalized.includes(route);
  });
}

function isFilenameOperatorChoiceConflict(conflict: string): boolean {
  const normalized = conflict.toLowerCase();
  const mentionsOperator =
    normalized.includes("operator") ||
    normalized.includes("оператор") ||
    normalized.includes("брэнд");
  const mentionsFilename =
    normalized.includes("file name") ||
    normalized.includes("filename") ||
    normalized.includes("файлын нэр");
  return mentionsOperator && mentionsFilename;
}

function isCorruptedPricePattern(value: string): boolean {
  return /\b\d{1,3}[,.]\d{4}[,.]\d{3}\b/.test(value);
}

function isGenericExtractionMissConflict(
  conflict: string,
  actions: AITripAction[],
): boolean {
  if (actions.length === 0) return false;
  const normalized = conflict.toLowerCase();
  if (!/(тодорхойгүй|unknown|missing)/.test(normalized)) return false;
  const fieldMentions = [
    /маршрут|route/,
    /оператор|operator|брэнд/,
    /үнэ|price/,
    /огноо|гарах өдөр|date/,
  ].filter((pattern) => pattern.test(normalized)).length;
  return fieldMentions >= 3;
}

/**
 * Suppresses false "price conflict" questions that are actually date-based
 * seasonal pricing. The model sometimes lists multiple MNT prices from the
 * same tour (e.g. 3,590,000₮ / 3,660,000₮ / 3,260,000₮) and flags them as
 * a conflict even though they each belong to a different departure date or
 * passenger type. We suppress the conflict when:
 * 1. The conflict text contains two or more distinct MNT price figures, AND
 * 2. At least one action already has multiple departure_dates (meaning
 *    date-based pricing was successfully extracted), OR the notes/
 *    source_description already encodes date→price information.
 */
function isDateBasedPricingConflict(
  conflict: string,
  actions: AITripAction[],
): boolean {
  // Must mention prices — look for multiple ₮ amounts or "үнэ" + numbers
  const priceMatches = conflict.match(/[\d,]+(?:,\d{3})*(?:₮|төгрөг)/g) ?? [];
  if (priceMatches.length < 2) return false;

  // Must be about price differences (not some other kind of conflict)
  const normalized = conflict.toLowerCase();
  const isPriceConflict =
    normalized.includes("үнэ") ||
    normalized.includes("price") ||
    normalized.includes("өөр") ||
    normalized.includes("different");
  if (!isPriceConflict) return false;

  // Suppress if any action has multiple departure_dates (date-based pricing confirmed)
  const hasMultiDateAction = actions.some(
    (action) =>
      Array.isArray(action.fields?.departure_dates) &&
      action.fields.departure_dates.length > 1,
  );
  if (hasMultiDateAction) return true;

  // Suppress if notes/source_description encodes date→price mapping
  // (e.g. "6-р сарын 27: 3,590,000₮")
  const hasDatePriceNotes = actions.some((action) => {
    const notes = String(action.fields?.notes ?? action.fields?.source_description ?? "");
    return /[0-9]\s*сарын\s*[0-9].*[0-9]+,\d{3}/.test(notes);
  });
  return hasDatePriceNotes;
}

export function validateAIChangeProposal(
  proposal: AIChangeProposal | null,
  existingTrips: TravelTrip[] = [],
  options?: { forbidCreate?: boolean },
): ProposalValidationReport {
  const normalized = normalizeProposal(proposal);
  const blockingConflicts: string[] = [];
  const normalizedConflictItems = (normalized.conflict_items || []).map((item) => ({
    ...item,
    severity:
      item.type === "ocr_suspect" && isCorruptedPricePattern(item.text)
        ? ("blocker" as ConflictSeverity)
        : item.severity,
  }));
  const structuredSeverity = new Map(
    normalizedConflictItems.map((item) => [item.text, item.severity]),
  );
  const hasStructuredConflicts = structuredSeverity.size > 0;
  const confirmationConflicts = normalized.conflicts.filter(
    (conflict) =>
      (!hasStructuredConflicts || structuredSeverity.get(conflict) === "blocker") &&
      !isAgencyHeaderConflict(conflict) &&
      !isFilenameOperatorChoiceConflict(conflict) &&
      !isResolvedMissingDateConflict(conflict, normalized.actions) &&
      !isGenericExtractionMissConflict(conflict, normalized.actions) &&
      !isDateBasedPricingConflict(conflict, normalized.actions) &&
      !isGenericConfirmationText(conflict) &&
      !isOptionalAddOnCostConflict(conflict) &&
      !isDocumentedMealExceptionConflict(conflict),
  );
  const sanitizedActions: AITripAction[] = [];

  for (const rawAction of normalized.actions) {
    if (!rawAction || typeof rawAction !== "object") continue;

    let verb = String(rawAction.action || "").trim().toLowerCase();
    let tripId = rawAction.trip_id?.trim() || undefined;
    const cleanedFields = cleanFields(rawAction.fields || {});
    const match = {
      operator_name: rawAction.match?.operator_name?.trim() || undefined,
      route_name: rawAction.match?.route_name?.trim() || undefined,
    };
    const routeName = cleanedFields.route_name || match.route_name || "";
    const operatorName = cleanedFields.operator_name || match.operator_name || "";
    const label = buildConflictLabel(routeName, operatorName);
    const matchingTrips = findTripMatches(existingTrips, match.operator_name, match.route_name);

    // Upsert must never replace an existing trip with defaults for omitted
    // fields. Once a target is known, this is a partial patch.
    if (verb === "upsert" && (tripId || matchingTrips.length === 1)) {
      verb = "patch";
      tripId = tripId || matchingTrips[0]?.id;
    }

    if (isAgencyHeaderName(routeName) && !cleanedFields.adult_price && !cleanedFields.child_price) {
      // Agency name used as trip title AND no price data — true header row, skip silently.
      continue;
    }
    if (isAgencyHeaderName(routeName) && (cleanedFields.adult_price || cleanedFields.child_price)) {
      // Agency name as route_name BUT has real price data — the model got confused.
      // Flag it so the admin can rename, rather than silently losing real trip data.
      confirmationConflicts.push(
        `Аялалын нэр "${routeName}" нь агентлагийн нэртэй давхцаж байна. Аяллын жинхэнэ нэрийг оруулна уу.`,
      );
    }

    if (verb !== "upsert" && verb !== "patch" && verb !== "cancel") {
      blockingConflicts.push(`${label}: unsupported action "${verb || "unknown"}".`);
      continue;
    }

    if (
      (verb === "patch" || verb === "cancel") &&
      tripId &&
      !existingTrips.some((trip) => trip.id === tripId)
    ) {
      blockingConflicts.push(`${label}: target trip was not found.`);
      continue;
    }

    if (!isReasonableMoney(cleanedFields.adult_price)) {
      blockingConflicts.push(`${label}: adult price is outside the allowed range.`);
      continue;
    }
    if (!isReasonableMoney(cleanedFields.child_price)) {
      blockingConflicts.push(`${label}: child price is outside the allowed range.`);
      continue;
    }
    if (!isReasonableSeats(cleanedFields.seats_total)) {
      blockingConflicts.push(`${label}: total seats is outside the allowed range.`);
      continue;
    }
    if (!isReasonableSeats(cleanedFields.seats_left)) {
      blockingConflicts.push(`${label}: seats left is outside the allowed range.`);
      continue;
    }

    if (
      typeof cleanedFields.adult_price === "number" &&
      typeof cleanedFields.child_price === "number" &&
      cleanedFields.child_price > cleanedFields.adult_price
    ) {
      confirmationConflicts.push(
        `${label}: child price (${cleanedFields.child_price}) is higher than adult price (${cleanedFields.adult_price}).`,
      );
    }

    if (
      typeof cleanedFields.seats_total === "number" &&
      typeof cleanedFields.seats_left === "number" &&
      cleanedFields.seats_left > cleanedFields.seats_total
    ) {
      confirmationConflicts.push(
        `${label}: seats left (${cleanedFields.seats_left}) is greater than total seats (${cleanedFields.seats_total}).`,
      );
    }

    if (
      cleanedFields.status === "sold_out" &&
      typeof cleanedFields.seats_left === "number" &&
      cleanedFields.seats_left > 0
    ) {
      confirmationConflicts.push(
        `${label}: status is sold_out but seats left is ${cleanedFields.seats_left}.`,
      );
    }

    if (Array.isArray(cleanedFields.departure_dates)) {
      const validDates: string[] = [];
      const invalidDates: string[] = [];
      for (const value of cleanedFields.departure_dates) {
        const normalizedDate = normalizeDateText(String(value || ""));
        if (!normalizedDate) continue;
        if (
          (!/\d/.test(normalizedDate) && !isRecurringDepartureText(normalizedDate)) ||
          normalizedDate.length > 60
        ) {
          invalidDates.push(String(value || "").trim());
          continue;
        }
        if (!validDates.includes(normalizedDate)) validDates.push(normalizedDate);
      }
      cleanedFields.departure_dates = validDates;
      if (invalidDates.length > 0) {
        confirmationConflicts.push(
          `${label}: some departure dates could not be trusted (${invalidDates.join(", ")}).`,
        );
      }
    }

    if ((verb === "patch" || verb === "cancel") && !tripId && !match.route_name && !match.operator_name) {
      blockingConflicts.push(`${label}: update/cancel actions must include trip_id or match fields.`);
      continue;
    }

    if (verb === "patch" && Object.keys(cleanedFields).length === 0) {
      blockingConflicts.push(`${label}: patch action has no fields to update.`);
      continue;
    }

    if (verb === "upsert") {
      const fieldsRoute = cleanedFields.route_name?.trim() || "";
      const fieldsOperator = cleanedFields.operator_name?.trim() || "";
      if (!tripId && !match.route_name && isMissingTripName(fieldsRoute)) {
        blockingConflicts.push(`${label}: new or updated trips must include a route name.`);
        continue;
      }
      if (isMissingTripName(fieldsRoute || match.route_name)) {
        blockingConflicts.push(`${label}: new trips must include a real trip name.`);
        continue;
      }
      if (options?.forbidCreate) {
        blockingConflicts.push(
          `${label}: шинэ аялал нэмэхгүй гэсэн тул одоо байгаа аялалтай тааруулж чадсангүй.`,
        );
        continue;
      }
      if (!tripId && !match.operator_name && !fieldsOperator && !match.route_name) {
        blockingConflicts.push(`${label}: new trips must include an operator name.`);
        continue;
      }

      if (!tripId && !match.route_name && fieldsRoute && fieldsOperator) {
        const duplicateTrips = findTripMatches(existingTrips, fieldsOperator, fieldsRoute);
        if (duplicateTrips.length > 0) {
          confirmationConflicts.push(
            `${label}: an existing trip already matches this operator and route, so review before creating a duplicate.`,
          );
        }
      }
    }

    if ((verb === "patch" || verb === "cancel" || verb === "upsert") && !tripId && (match.route_name || match.operator_name)) {
      if (matchingTrips.length === 0 && verb !== "upsert") {
        blockingConflicts.push(`${label}: matching trip not found.`);
        continue;
      }
      if (matchingTrips.length > 1) {
        blockingConflicts.push(`${label}: multiple trips match the same operator/route.`);
        continue;
      }
    }

    if (verb === "cancel") {
      cleanedFields.status = "cancelled";
    }

    // A brand-new upsert (no trip_id / no match) cannot logically start as
    // cancelled or sold_out — the model sometimes hallucinates these from
    // itinerary booking phrases ("суудал авах", "нөөцлөх", "аялал өндөрлөнө").
    if (verb === "upsert" && !tripId && !match.route_name && !match.operator_name) {
      if (cleanedFields.status === "cancelled" || cleanedFields.status === "sold_out") {
        cleanedFields.status = "active";
      }
    }

    if (cleanedFields.status === "cancelled") {
      confirmationConflicts.push(`${label}: this action cancels a trip and should be reviewed.`);
    }

    const sanitizedAction: AITripAction = {
      action: verb as AITripAction["action"],
      ...(tripId ? { trip_id: tripId } : {}),
      ...(match.operator_name || match.route_name ? { match } : {}),
      ...(Object.keys(cleanedFields).length > 0 ? { fields: cleanedFields } : {}),
    };
    sanitizedActions.push(sanitizedAction);
  }

  const targetNames = new Map<string, Set<string>>();
  for (const action of sanitizedActions) {
    const target = action.trip_id?.trim();
    const nextName = action.fields?.route_name?.trim();
    if (!target || !nextName) continue;
    const names = targetNames.get(target) || new Set<string>();
    names.add(nextName.toLowerCase());
    targetNames.set(target, names);
  }
  for (const names of targetNames.values()) {
    if (names.size > 1) {
      blockingConflicts.push(
        "Нэг аялалд хоёр өөр нэр таарсан тул автоматаар хадгалсангүй. Файлын дарааллыг шалгана уу.",
      );
    }
  }

  const proposalConflicts = dedupeStrings([
    ...confirmationConflicts,
    ...blockingConflicts,
  ]);
  const finalActions = dedupeActions(sanitizedActions);
  const genericOnlyConfirmation =
    normalized.needs_confirmation &&
    proposalConflicts.length === 0 &&
    blockingConflicts.length === 0 &&
    finalActions.length > 0 &&
    finalActions.every(isCompleteCleanAction) &&
    isGenericConfirmationText(normalized.important_reason);
  const needsConfirmation =
    proposalConflicts.length > 0 ||
    blockingConflicts.length > 0 ||
    (normalized.needs_confirmation && !genericOnlyConfirmation);
  // Keep conflict_items aligned with the filtered proposalConflicts set. Items
  // whose text was filtered out (agency headers, generic confirmations, etc.)
  // are dropped; new blocking conflicts from validation get severity "blocker".
  const proposalConflictSet = new Set(proposalConflicts);
  const filteredItems: ConflictItem[] = normalizedConflictItems.filter(
    (item) => item.severity !== "blocker" || proposalConflictSet.has(item.text),
  );
  const existingItemTexts = new Set(filteredItems.map((i) => i.text));
  const newBlockingItems: ConflictItem[] = blockingConflicts
    .filter((text) => !existingItemTexts.has(text))
    .map((text) => ({ text, severity: "blocker" as ConflictSeverity, type: "validation" }));
  const finalConflictItems: ConflictItem[] = [...filteredItems, ...newBlockingItems];

  const finalProposal: AIChangeProposal = {
    ...normalized,
    needs_confirmation: needsConfirmation,
    important_reason: genericOnlyConfirmation ? "" : normalized.important_reason,
    conflicts: proposalConflicts,
    conflict_items: finalConflictItems,
    actions: finalActions,
  };

  return {
    proposal: finalProposal,
    blocking_conflicts: dedupeStrings(blockingConflicts),
    auto_apply_ready:
      finalProposal.actions.length > 0 &&
      finalProposal.conflicts.length === 0 &&
      finalProposal.needs_confirmation === false,
  };
}

function dedupeActions(actions: AITripAction[]): AITripAction[] {
  const seen = new Set<string>();
  const result: AITripAction[] = [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function buildProposalRepairGuide(rawText: string): string {
  return [
    "Convert the following model output into valid JSON only.",
    "Return exactly one JSON object with this schema:",
    "{",
    '  "summary": "short summary",',
    '  "needs_confirmation": true,',
    '  "important_reason": "reason",',
    '  "conflicts": [],',
    '  "conflict_items": [{ "text": "...", "severity": "info|warning|blocker", "type": "optional" }],',
    '  "actions": [',
    '    { "action": "upsert|patch|cancel", "trip_id": "", "match": { "operator_name": "", "route_name": "" }, "fields": {} }',
    "  ]",
    "}",
    "Do not add markdown fences or explanation text.",
    "",
    "Model output to repair:",
    rawText,
  ].join("\n");
}

function buildProposalGuide(condensedTrips: unknown): string {
  return [
    "Та travel operations data assistant байна.",
    "Доорх мэдээллээс trips өгөгдлийн санд хийх өөрчлөлтийг тодорхойлж, ЗӨВХӨН JSON буцаа.",
    "Тайлбар текст, markdown, ```код```-ийн хашилт БҮҮ нэм.",
    "",
    "JSON schema:",
    "{",
    '  "summary": "товч дүгнэлт (монголоор)",',
    '  "needs_confirmation": true/false,',
    '  "important_reason": "яагаад баталгаажуулах ёстой эсэх",',
    '  "conflicts": [],',
    '  "conflict_items": [',
    '    { "text": "хүний ойлгох тайлбар (монголоор)", "severity": "info|warning|blocker", "type": "optional_type_tag" }',
    "  ],",
    '  "actions": [',
    "    {",
    '      "action": "upsert|patch|cancel",',
    '      "trip_id": "trip id (optional)",',
    '      "match": { "operator_name": "...", "route_name": "..." },',
    '      "fields": {',
    '        "category": "", "operator_name": "", "route_name": "", "duration_text": "",',
    '        "adult_price": 0, "child_price": 0, "currency": "MNT|CNY",',
    '        "departure_dates": ["..."], "seats_total": null, "seats_left": null,',
    '        "has_food": true, "status": "active|cancelled|sold_out|draft",',
    '        "notes": "", "source_description": "",',
    '        "extra": {',
    '          "tour_title": "canonical product title", "route": "actual travel path",',
    '          "duration_days": null, "duration_nights": null,',
    '          "recurring_schedule": null, "departure_date_groups": [],',
    '          "infant_prices": [], "single_room_supplements": [], "foreign_currency_fees": [],',
    '          "transport": [], "included_items": [], "excluded_items": [], "itinerary_days": [],',
    '          "source_file_name": "", "original_title_text": "",',
    '          "extraction_confidence": { "operator": "high|medium|low", "title": "high|medium|low", "dates": "high|medium|low", "prices": "high|medium|low", "duration": "high|medium|low" }',
    "        }",
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    'conflict_items severity дүрэм (ХАМГИЙН ЧУХАЛ):',
    '- "blocker": зөвхөн жинхэнэ зөрчил — ижил аялал+ижил огноо+ижил аялагчдын төрөл+тайлбаргүй өөр үнэ. Blocker байвал needs_confirmation=true болгоно.',
    '- "warning": анхаарал хэрэгтэй боловч хадгалахыг зогсоохгүй. Жишээ: тодорхойгүй талбар, нэмэлт зардал.',
    '- "info": ердийн мэдээлэл. Хадгалахыг зогсоохгүй, асуухгүй. Жишээ: дүрмийн мэдэгдэл.',
    'conflict_items дэх "type" (заавал биш, тогтмол ашиглавал):',
    '  adult_child_normal | date_based_pricing | optional_addon | duplicate_route | true_price_conflict | ocr_suspect | meal_exception',
    "",
    "Баталгаажуулалт заавал true болгох нөхцөл:",
    "- Маршрут цуцлах (status=cancelled),",
    "- Үнийн том өөрчлөлт,",
    "- Суудал 0 болгох эсвэл sold_out болгох,",
    "- Нэгээс олон маршрут таарах магадлалтай үед,",
    "- Файлаас уншсан өгөгдөл бүрхэг/эргэлзээтэй үед.",
    "",
    "Дүрэм:",
    "- Одоо байгаа маршрутыг шинэчлэхдээ trip_id эсвэл match (operator_name+route_name) ашигла.",
    "- Шинэ маршрут бол action='upsert', trip_id хоосон үлдээ.",
    "- Мэдээлэл байхгүй талбарыг БҮҮ таа — fields-ээс орхи.",
    "- Үнийн валют: 'юань'/'yuan' → CNY, 'төгрөг'/'сая' эсвэл 6+ оронтой тоо → MNT.",
    "- Хэрэв ямар ч өөрчлөлт хийх шаардлагагүй бол actions хоосон массив байг.",
    "",
    "Талбар таних заавар (админ ярианы хэлээр асууж магадгүй):",
    "- 'Огноо', 'хэзээ', 'гарах өдөр', 'цаг' → departure_dates. 'өдөр бүр', 'daily', 'пүрэв гараг бүр' зэрэг давтагдах хуваарь ХҮЧИНТЭЙ departure_dates утга — огноо алга гэж бүү тооц.",
    "- Тодорхой цагийн мэдээлэл (ж: '09:00 цагт') departure_dates-д эсвэл notes-д бич.",
    "- 'Газар', 'байршил', 'хаашаа', 'чиглэл', 'маршрут' → route_name (шаардлагатай бол notes-д дэлгэрэнгүй).",
    "- 'Суудал', 'хүн', 'багтаамж' → seats_total/seats_left. 'Суудал дүүрсэн/дууссан' → status=sold_out.",
    "- Зөвхөн нэг талбар өөрчлөхөд action='patch' ашиглаж, бусад талбарыг БҮҮ хүр.",
    "- Хэрэглэгч шинэ аялал нэмэхгүй, зөвхөн одоо байгаа аяллын нэрийг нөх гэж хэлбэл ЗӨВХӨН action='patch' ашигла. Одоо байгаа нэргүй аяллын trip_id-г заавал сонго; action='upsert' бүү ашигла.",
    "- Нэрсийг дарааллаар нөхөх хүсэлтэд source-ийн эхний нэрийг created_order=1 нэргүй аялалтай, дараагийн нэрийг created_order=2-той тус тус тааруул.",
    "- Админ 'үүнийг'/'энэ аяллыг' гэж тодорхойгүй заавал, аль аялал болохыг trips жагсаалтаас тааруул. Олон аялал таарвал эсвэл огт тодорхойгүй бол needs_confirmation=true болгон аль аяллыг асуу.",
    "",
    "=== TRAVEL AGENCY DOMAIN RULES FOR conflict_items ===",
    "",
    "ХЭВИЙН зүйл — ОГТХОН Ч зөрчил биш (conflict_items дотор дурдахгүй):",
    "  • Том хүний үнэ > хүүхдийн үнэ > нярайн үнэ (эсвэл тэнцүү) — аялалын агентлагийн ердийн дүрэм",
    "  • Нэг аяллын олон гарах огноо — олон хуваарьтай байх нь хэвийн",
    "  • Сар, улирал, эсвэл гарах огноогоор үнэ өөр — ердийн сезоны үнэ (departure_dates+notes-д бич, blocker болгохгүй)",
    "  • Нэмэлт төлбөр CNY/юань-аар (шинжилгээ, хувийн зардал, single room, нэмэлт үзвэр) — notes-д хадгал",
    "  • Хоол зарим өдрөөр хэрэглэгчийн зардлаар (чөлөөт өдрүүд) — has_food=true, notes-д тайлбарла",
    "  • 'Пүрэв гараг бүр', 'өдөр бүр', 'сар бүр' зэрэг давтагдах хуваарь — хүчинтэй departure_dates",
    "",
    "INFO (severity='info') — мэдээлэл, хадгалахыг зогсоохгүй, асуухгүй:",
    "  • Аялалын нэрийг нарийвчлах боломжтой боловч одоогийн нэр бас зөв",
    "  • Single room нэмэлт нь суурь үнийн гаднах зардал гэдгийг тодруулах",
    "",
    "WARNING (severity='warning') — анхаарал хэрэгтэй, хадгалахыг ЗОГСООХГҮЙ, зөвхөн yellow box:",
    "  • Нэр маш ижил хоёр аялал давхцаж магадгүй — нягтлаарай",
    "  • Тоон утга буруу унших эрсдэлтэй мэт (ж: 2,6360,000 — OCR алдаа байж болох)",
    "  • Verification pass-ийн зөрүү",
    "",
    "BLOCKER (severity='blocker') — жинхэнэ зөрчил, needs_confirmation=true БОЛГОХ, менежерт АСУУХ:",
    "  • Ижил аялал + ижил огноо + ижил аялагчдын төрөл + тайлбаргүй өөр үнэ",
    "  • Хүүхдийн үнэ > том хүний үнэ (урвуу — буруу мэт)",
    "  • Маршрутын нэр (route_name) огт байхгүй бол blocker болго; operator_name байхгүй бол 'UUDAM TRAVEL AGENCY' гэж бич — blocker биш",
    "  • Цуцлах (status=cancelled) үйлдэл — менежер баталгаажуулах ёстой",
    "",
    "TEXT FORMAT дүрэм:",
    "- Энгийн, ойлгомжтой ярианы хэлээр бич. Аялалын менежертэй ярьж байгаа мэт.",
    "- Техник нэр томьёо, талбарын нэр, ID (trip_id, route_name, seed-33 г.м.) БҮҮ дурд.",
    "- Аяллын нэрийг ХАШИЛТАНД бич (ж: \"Жэжү арлын аялал 2026\").",
    "- Аль зүйл тодорхойгүй болон яг утгуудыг нь энгийнээр дурд.",
    "- \"Нэг аяллын...\", \"зарим аялал...\" гэх ерөнхий бичлэг хориотой.",
    "- Гарах огноог departure_dates-д оруулсан бол conflicts-д 'огноо тодорхойгүй' гэж БҮҮ бич.",
    "- Сайн жишээ: { \"text\": \"\\\"Хөх хотын шинжилгээтэй аялал\\\"-ыг шинэ аялал болгон нэмэх үү, эсвэл одоо байгааг шинэчлэх үү?\", \"severity\": \"blocker\", \"type\": \"duplicate_route\" }",
    "- Муу жишээ (БҮҮ): { \"text\": \"...-д том хүний үнэ хүүхдийн үнэ-өөс өндөр байна.\", \"severity\": \"blocker\" } — ЭНЭ НЬ ХЭВИЙН, blocker болгохгүй.",
    "",
    `Одоогийн trips (JSON): ${JSON.stringify(condensedTrips)}`,
  ].join("\n");
}

function buildBatchSourceParts(input: {
  note?: string;
  sources: ProposalSource[];
}) {
  const parts: GeminiPart[] = [];
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

// Max chars per individual Gemini call for text-only sources. JSON-mode
// structured extraction on Flash is slow, so keep each call small.
const MAX_TEXT_CHARS_PER_BATCH = 18_000;
// Max numbered trips per chunk. Even a small char count can hold many trips,
// and emitting many trip JSON objects (with full extra metadata) in one call
// blows past the 45s timeout. 4 keeps each Gemini call fast (~15-20s).
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
 * labelled sources so each gets its own fast Gemini call.
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
    "- If a value in the source is genuinely unreadable, list it as a mismatch too.",
    "- If everything matches exactly, return all_correct=true and mismatches=[].",
    "- Do NOT invent trips or add new data. Only verify what is given.",
  ].join("\n");
}

async function verifyProposalAgainstSource(opts: {
  proposal: AIChangeProposal;
  userParts: GeminiPart[];
  source: string;
  model?: string;
}): Promise<AIChangeProposal> {
  // Nothing to verify if there are no concrete actions.
  if (!opts.proposal.actions.length) return opts.proposal;

  try {
    const result = await askGeminiParts(
      [{ text: buildVerificationGuide(opts.proposal.actions) }, ...opts.userParts],
      {
        source: `${opts.source}.verify`,
        jsonMode: true,
        timeoutMs: FILE_PARSE_VERIFY_TIMEOUT_MS,
        maxRetries: 0,
        model: opts.model,
        temperature: 0,
        // File reading → OpenAI primary, Gemini backup.
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

    const mismatches = Array.isArray(parsed.mismatches)
      ? parsed.mismatches.map((m) => String(m)).filter(Boolean)
      : [];

    if (parsed.all_correct === true && mismatches.length === 0) {
      return opts.proposal; // verified clean
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
  userParts: GeminiPart[];
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  model?: string;
  verify?: boolean;
}) {
  // OpenAI is primary for all proposal extraction (file parsing + text instructions).
  // Gemini is the fallback when OpenAI is unavailable or the input contains native
  // PDF inline parts (OpenAI vision doesn't accept application/pdf directly — those
  // are rendered to JPEG pages by fileParse.ts before reaching here).
  // Messenger chat replies stay on Gemini (better Mongolian) — this path never runs there.
  const result = await askGeminiParts(
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
      const repaired = await askGeminiParts(
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

  // Accuracy-first second pass: verify extracted numbers against the source.
  if (opts.verify && FILE_PARSE_VERIFY && proposal.actions.length > 0) {
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
  const result = await askGeminiParts([{ text: opts.prompt }], {
    source: opts.source,
    jsonMode: true,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });

  let parsed = parseJsonFromModel(result.text);
  if (!parsed) {
    try {
      const repaired = await askGeminiParts(
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
  userParts?: GeminiPart[];
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
    timeoutMs: AI_CHANGE_GEMINI_TIMEOUT_MS,
    maxRetries: AI_CHANGE_GEMINI_MAX_RETRIES,
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
  const parts: GeminiPart[] = [];
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

/**
 * Collapses multiple actions that target the SAME trip into one. Multi-image
 * uploads (a messenger-split zip = several slices of one poster) make the
 * model emit one partial action per image — e.g. one carrying dates+prices,
 * another carrying meals+photo — which showed up as confusing duplicate rows
 * and split the photos across actions. Fields fill forward (first non-empty
 * wins), list fields union.
 */
export function mergeDuplicateTripActions(proposal: AIChangeProposal): void {
  const byKey = new Map<string, AITripAction>();
  const mergedActions: AITripAction[] = [];
  for (const action of proposal.actions) {
    const verb = String(action.action || "").toLowerCase();
    const key = `${verb}|${tripActionKey(action)}`;
    const existing = verb !== "cancel" ? byKey.get(key) : undefined;
    if (!existing || key.endsWith("name:")) {
      byKey.set(key, action);
      mergedActions.push(action);
      continue;
    }
    const target = (existing.fields ?? {}) as Record<string, unknown>;
    const source = (action.fields ?? {}) as Record<string, unknown>;
    for (const [field, value] of Object.entries(source)) {
      if (value == null || value === "") continue;
      if (field === "photo_urls" || field === "departure_dates") {
        target[field] = unionStringArrays(target[field], value);
      } else if (field === "extra" && typeof value === "object") {
        target[field] = { ...(target[field] as object ?? {}), ...(value as object) };
      } else if (target[field] == null || target[field] === "") {
        target[field] = value;
      }
    }
    if (!existing.fields) (existing as { fields?: Record<string, unknown> }).fields = target;
  }
  proposal.actions = mergedActions;
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
  for (const [label, urls] of photoUrlMap) {
    // 1) Exact source_file_name match still wins.
    const exact = actions.find((action) => {
      const extra = action.fields?.extra as Record<string, unknown> | undefined;
      return extra?.source_file_name === label;
    });
    if (exact) {
      addUrls(exact, urls);
      continue;
    }

    // 2) Token-overlap: best action whose route name shares identity tokens
    //    with the filename. Two guards against misattaching (wrong poster on
    //    a trip is worse than no poster): at least one matched token of
    //    length >= 4, AND >= 60% of the filename's identity tokens must match
    //    — so "ЖИНИНЬ ... МИНИ АВАТАР ХӨХ ХОТ.zip" can't latch onto the
    //    separate "Мини Аватар - Хөх хот - Датон" trip on partial overlap.
    const labelTokens = photoMatchTokens(label);
    let bestIndex = -1;
    let bestScore = 0;
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
      if (hasStrongToken && coverage >= 0.6 && score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    if (bestIndex >= 0) {
      addUrls(actions[bestIndex], urls);
      continue;
    }

    // 3) Single action -> everything belongs to it.
    if (actions.length === 1) {
      addUrls(actions[0], urls);
      continue;
    }
    unmatchedLabels.push(label);
  }

  // Surface (as a non-blocking warning, never a question) any photos we
  // could not confidently place, instead of dropping them silently.
  if (unmatchedLabels.length > 0) {
    const shown = unmatchedLabels.slice(0, 3).join(", ");
    const warning = `Зарим зургийг аль аялалд хамаарахыг тодорхойлж чадсангүй: ${shown}${unmatchedLabels.length > 3 ? "…" : ""}. Хадгалсны дараа "Зураг оруулах" табаас гараар нэмнэ үү.`;
    if (!merged.conflicts.includes(warning)) merged.conflicts.push(warning);
    merged.conflict_items = [
      ...(merged.conflict_items || []),
      { text: warning, severity: "warning" as ConflictSeverity, type: "photo_unmatched" },
    ];
  }
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
  // sub-chunks so each Gemini call only extracts a handful of trips and
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
          FILE_PARSE_GEMINI_TIMEOUT_MS,
          Math.max(FILE_PARSE_MIN_BATCH_TIMEOUT_MS, remainingMs - 5_000),
        );
        const batchRetries =
          FILE_PARSE_GEMINI_MAX_RETRIES > 0 &&
          remainingMs >
            batchTimeoutMs + FILE_PARSE_MIN_BATCH_TIMEOUT_MS + FILE_PARSE_BATCH_DELAY_MS
            ? FILE_PARSE_GEMINI_MAX_RETRIES
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
          logError("travel.ai.file_batch_failed", {
            source: "travel.ops.file_parse",
            batchLabels,
            message,
          });
          proposals.push({
            summary: `Could not finish reading batch: ${batchLabels}`,
            needs_confirmation: true,
            important_reason:
              "One batch of uploaded files took too long or failed upstream, so the result may be incomplete.",
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

      return merged;
    },
  });
}

function buildProposalRevisionGuide(input: {
  instruction: string;
  currentProposal: AIChangeProposal;
  clarification: string;
  condensedTrips: unknown;
}) {
  return [
    "You are revising an existing travel-ops proposal after a short admin clarification.",
    "Preserve every action's photo_urls array EXACTLY as-is — never drop, truncate, or rewrite those URLs.",
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
    `Current proposal JSON: ${JSON.stringify(input.currentProposal)}`,
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

  // Models routinely drop the long Cloudinary photo URLs during revision —
  // restore them from the pre-revision actions so answering a clarification
  // never silently costs the attached photos.
  carryOverPhotoUrls(currentProposal, revisedProposal);

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
        !/matching trip not found/i.test(match.conflict)
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
