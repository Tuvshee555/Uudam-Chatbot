/**
 * AI change-proposal validation & conflict classification.
 *
 * Extracted from travelAI.ts (over the 2,000-line cap). Pure logic that decides
 * whether a proposed set of trip changes is safe to apply and which conflicts
 * are real blockers vs. benign. Depends only on travelDb helpers + types — a
 * clean leaf. Re-exported from travelAI.ts so travelOps and the validation tests
 * keep importing it unchanged.
 */

import type {
  AITripAction,
  ConflictSeverity,
  ConflictItem,
  AIChangeProposal,
  ProposalValidationReport,
  TravelTrip,
} from "./travelTypes";
import {
  normalizeProposal,
  cleanFields,
  dedupeStrings,
  buildConflictLabel,
  findTripMatches,
  isAgencyHeaderName,
  isAgencyHeaderConflict,
  isOptionalAddOnCostConflict,
  isDocumentedMealExceptionConflict,
  isGenericConfirmationText,
  isReasonableMoney,
  isReasonableSeats,
  normalizeDateText,
  isRecurringDepartureText,
  isCompleteCleanAction,
} from "./travelDb";

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

export function isMissingTripName(value: string | undefined): boolean {
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
      const askedName = (match.route_name || routeName || "").trim();
      const askedTag = askedName ? `«${askedName}» ` : "";
      if (matchingTrips.length === 0 && verb !== "upsert") {
        blockingConflicts.push(
          `${askedTag}гэдэг нэртэй аялал бүртгэлд алга байна. Аяллын нэрээ бүртгэлтэй нэртэй нь яг адилхан бичээд дахин илгээгээрэй.`,
        );
        continue;
      }
      if (matchingTrips.length > 1) {
        const candidates = matchingTrips
          .slice(0, 3)
          .map((trip) => `• ${trip.route_name}`)
          .join("\n");
        if (verb === "upsert") {
          // A file/poster upsert whose route fuzzy-matches SEVERAL existing
          // trips (e.g. a "Хайлаар Манжуур Чичихар" poster vs the separate
          // Манжуур and Чичихар products). Guessing which record to overwrite
          // is how wrong trips get clobbered, but hard-blocking used to
          // dead-end the admin with an English message and no way forward.
          // Instead: keep the action as a CREATE (match stripped so apply
          // never re-resolves it onto the wrong record) and ask for one
          // confirmation, in plain conversational Mongolian.
          match.route_name = undefined;
          match.operator_name = undefined;
          confirmationConflicts.push(
            `${askedTag}аялал одоо байгаа ${matchingTrips.length} аялалтай төстэй байна:\n${candidates}\n\nБаталгаажуулбал ЭНЭ аяллыг ШИНЭ аялал болгож нэмнэ. Хэрэв дээрхийн аль нэгийг нь шинэчлэх гэсэн бол тэр аяллын бүтэн нэрийг бичээд дахин илгээгээрэй.`,
          );
        } else {
          blockingConflicts.push(
            `${askedTag}нэртэй төстэй ${matchingTrips.length} аялал байгаа тул алийг нь өөрчлөхийг таамаглаж чадсангүй:\n${candidates}\n\nАль аяллыг өөрчлөхөө бүтэн нэрээр нь бичээд дахин илгээгээрэй.`,
          );
          continue;
        }
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
    names.add(nextName);
    targetNames.set(target, names);
  }
  for (const [tripId, names] of targetNames) {
    const distinct = Array.from(names).filter(
      (name, i, arr) => arr.findIndex((o) => o.toLowerCase() === name.toLowerCase()) === i,
    );
    if (distinct.length > 1) {
      const current = existingTrips.find((trip) => trip.id === tripId)?.route_name;
      const currentTag = current ? ` (одоогийн нэр: "${current}")` : "";
      blockingConflicts.push(
        `Нэг аялалд${currentTag} хоёр өөр нэр таарсан тул автоматаар хадгалсангүй: ${distinct.map((n) => `"${n}"`).join(" болон ")}. Аль нэрийг хэрэглэхийг сонгоно уу.`,
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

export function dedupeActions(actions: AITripAction[]): AITripAction[] {
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
