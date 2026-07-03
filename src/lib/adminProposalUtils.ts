/* ----------------------------------------------------------------
   Proposal conflict classification + clarification builder
   Extracted from src/pages/admin.tsx — pure functions, no React state.
   ---------------------------------------------------------------- */

import type {
  AIAction,
  AIProposal,
  ClarificationQuestion,
  ConflictItem,
  ConflictSeverity,
  TripStatus,
} from "./adminTypes";

export const STATUS_LABELS: Record<TripStatus, string> = {
  active: "Идэвхтэй",
  cancelled: "Цуцлагдсан",
  sold_out: "Суудал дууссан",
  draft: "Ноорог",
};

export const FIELD_LABELS: Record<string, string> = {
  category: "Ангилал",
  operator_name: "Оператор",
  route_name: "Аяллын нэр",
  duration_text: "Хугацаа",
  adult_price: "Том хүний үнэ",
  child_price: "Хүүхдийн үнэ",
  currency: "Валют",
  departure_dates: "Гарах өдөр",
  seats_total: "Нийт суудал",
  seats_left: "Үлдсэн суудал",
  has_food: "Хоол",
  status: "Төлөв",
  notes: "Тэмдэглэл",
  source_description: "Эх сурвалж",
};

export function formatMoneyValue(
  amount: number | null | undefined,
  currency?: unknown,
): string {
  if (amount == null || !Number.isFinite(amount)) return "unknown";
  const code = typeof currency === "string" && currency.trim() ? currency.trim() : "";
  return `${amount.toLocaleString("en-US")}${code ? ` ${code}` : ""}`;
}

export function extractQuotedValues(text: string): string[] {
  const matches = Array.from(text.matchAll(/['"]([^'"]+)['"]/g));
  const values = matches.map((m) => m[1]?.trim() || "").filter(Boolean);
  return Array.from(new Set(values));
}

export function normalizeReviewText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function isAgencyReviewText(text: string): boolean {
  const normalized = normalizeReviewText(text).replace(/[.,:;!?()[\]{}"']/g, "");
  const agencyHeaders = [
    "uudam travel agency",
    "uudam travel",
    "travel agency",
    "agency",
  ];
  return agencyHeaders.some(
    (header) => normalized === header || normalized.startsWith(`${header} `),
  );
}

export function isLikelyTripRouteText(text: string): boolean {
  const normalized = normalizeReviewText(text);
  return (
    normalized.includes("аялал") ||
    normalized.includes("tour") ||
    normalized.includes("хөх хот") ||
    normalized.includes("эрээн") ||
    normalized.includes("бээжин") ||
    normalized.includes("seoul")
  );
}

export function isSuspiciousChildPriceConflict(normalized: string): boolean {
  const mentionsChild =
    normalized.includes("хүүхдийн үнэ") || normalized.includes("child price");
  if (!mentionsChild) return false;
  const mentionsComparison =
    normalized.includes("higher") ||
    normalized.includes("greater") ||
    normalized.includes("more than") ||
    normalized.includes("өндөр") ||
    normalized.includes("их") ||
    normalized.includes("давсан");
  if (!mentionsComparison) return false;

  // Word order: whichever subject (child/adult) comes first is being called higher.
  // Adult > child is normal. Only child > adult is suspicious.
  const childPos = Math.min(
    ...[normalized.indexOf("хүүхдийн үнэ"), normalized.indexOf("child price")]
      .filter((i) => i !== -1),
  );
  const adultPos = Math.min(
    ...[normalized.indexOf("том хүний үнэ"), normalized.indexOf("adult price")]
      .filter((i) => i !== -1),
  );
  if (!Number.isFinite(childPos)) return false;
  if (Number.isFinite(adultPos) && adultPos < childPos) return false;
  return true;
}

export function isContradictoryDateConflict(detail: string): boolean {
  const normalized = normalizeReviewText(detail);
  const mentionsUnclearDate =
    (normalized.includes("огноо") ||
      normalized.includes("гарах өдөр") ||
      normalized.includes("departure date")) &&
    (normalized.includes("тодорхойгүй") ||
      normalized.includes("unclear") ||
      normalized.includes("чадсангүй") ||
      normalized.includes("чадаагүй"));
  if (!mentionsUnclearDate) return false;
  return (
    /\d{1,2}\s*[\/.\-]\s*\d{1,2}/.test(detail) ||
    /\d{4}-\d{1,2}-\d{1,2}/.test(detail) ||
    /\d{1,2}\s*сар(ын)?\s*\d{1,2}/.test(detail)
  );
}

export function isOptionalAddOnCostConflict(normalized: string): boolean {
  const mentionsForeignCost =
    normalized.includes("cny") ||
    normalized.includes("yuan") ||
    normalized.includes("юань");
  if (!mentionsForeignCost) return false;
  return (
    normalized.includes("optional") ||
    normalized.includes("add-on") ||
    normalized.includes("addon") ||
    normalized.includes("extra") ||
    normalized.includes("нэмэлт төлбөр") ||
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("хөтөлбөрт багтаагүй") ||
    normalized.includes("ганцаараа орох") ||
    normalized.includes("single room")
  );
}

// Keep in sync with RECURRING_DEPARTURE_TOKENS in src/lib/travelOps.ts.
const RECURRING_DATE_TOKENS = [
  "өдөр бүр",
  "өдөр болгон",
  "өдөр тутам",
  "daily",
  "every day",
  "everyday",
  "гараг бүр",
  "долоо хоног бүр",
  "долоохоног бүр",
  "every week",
  "weekly",
  "пүрэв",
  "даваа",
  "мягмар",
  "лхагва",
  "баасан",
  "бямба",
  "ням",
  "thursday",
  "monday",
  "tuesday",
  "wednesday",
  "friday",
  "saturday",
  "sunday",
  "сар бүр",
  "monthly",
  "every month",
  "хоног тутам",
];

export function isRecurringDateText(normalized: string): boolean {
  return RECURRING_DATE_TOKENS.some((token) => normalized.includes(token));
}

export function isDocumentedMealExceptionConflict(normalized: string): boolean {
  const mentionsMeal =
    normalized.includes("хоол") ||
    normalized.includes("цай") ||
    normalized.includes("meal") ||
    normalized.includes("breakfast") ||
    normalized.includes("lunch") ||
    normalized.includes("dinner");
  if (!mentionsMeal) return false;
  return (
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("өөрсдийн зардлаар") ||
    normalized.includes("өөрөө") ||
    normalized.includes("чөлөөт өдөр") ||
    normalized.includes("байдаггүй") ||
    normalized.includes("байхгүй") ||
    normalized.includes("not included") ||
    normalized.includes("own expense") ||
    normalized.includes("free day")
  );
}

export function summarizeConflict(detail: string): string {
  const normalized = normalizeReviewText(detail);
  const quoted = extractQuotedValues(detail);
  const subject = quoted[0] || "Энэ аялал";

  if (isAgencyReviewText(subject) || isAgencyReviewText(detail)) return "";
  if (isOptionalAddOnCostConflict(normalized)) return "";
  if (isDocumentedMealExceptionConflict(normalized)) return "";
  if (isRecurringDateText(normalized)) return "";
  if (isSuspiciousChildPriceConflict(normalized)) {
    return `${subject}: хүүхдийн болон том хүний үнэ зөрүүтэй байна.`;
  }
  if (normalized.includes("юань") || normalized.includes("cny") || normalized.includes("валют")) {
    return `${subject}: үндсэн үнэ MNT, шинжилгээний төлбөр CNY байна.`;
  }
  if (normalized.includes("хоол") || normalized.includes("meal")) {
    return `${subject}: хоол багтсан эсэх нь тодорхойгүй байна.`;
  }
  if (
    normalized.includes("batch failed") ||
    normalized.includes("503") ||
    normalized.includes("upstream")
  ) {
    return "Зарим файл түр уншигдаагүй байна.";
  }
  const mnPriceCount = (detail.match(/[\d,]+(?:,\d{3})*\s*(?:₮|төгрөг)/g) ?? []).length;
  const mentionsMonthDay = /\d+\s*сар(?:ын|д|ны)?\s*\d+/.test(detail);
  if (
    normalized.includes("6-р сард") ||
    normalized.includes("7-р сард") ||
    normalized.includes("8-р сард") ||
    (mnPriceCount >= 2 && mentionsMonthDay)
  ) {
    return `${subject}: сар бүрийн үнэ өөр байна.`;
  }
  if (
    normalized.includes("file") ||
    normalized.includes("файлын нэр") ||
    normalized.includes("operator") ||
    normalized.includes("оператор") ||
    normalized.includes("брэнд")
  ) {
    return "";
  }
  return "";
}

/** Compact warning text for info/warning-severity items (shown as a yellow box, not a question). */
export function compactWarnings(proposal: AIProposal): string[] {
  const items: ConflictItem[] = proposal.conflict_items || [];
  const nonBlockers = items.filter((i) => i.severity !== "blocker");
  if (nonBlockers.length > 0) {
    return nonBlockers.map((i) => i.text).filter(Boolean);
  }
  // Fall back to the flat conflict list when no structured items present.
  return proposal.conflicts.map(summarizeConflict).filter(Boolean);
}

export function describeAction(action: AIAction): {
  verb: string;
  target: string;
  changes: string[];
} {
  const verbRaw = String(action.action || "").toLowerCase();
  const verb =
    verbRaw === "cancel"
      ? "Цуцлах"
      : verbRaw === "upsert"
        ? action.trip_id
          ? "Шинэчлэх"
          : "Шинэ аялал нэмэх"
        : verbRaw === "patch"
          ? "Шинэчлэх"
          : verbRaw || "Үйлдэл";
  const target =
    action.match?.route_name ||
    action.fields?.route_name?.toString() ||
    action.match?.operator_name ||
    action.trip_id ||
    "аялал";
  const fields = action.fields || {};
  const changes: string[] = [];
  const targetNorm = String(target).trim().toLowerCase();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    // Skip values that add zero information — every skipped word here is one
    // the admin doesn't have to read on every single proposal row.
    if (key === "route_name" && String(value).trim().toLowerCase() === targetNorm) continue; // already the row heading
    if (key === "operator_name" && /uudam\s*travel/i.test(String(value))) continue; // own agency, always identical
    if (key === "currency" && String(value).toUpperCase() === "MNT") continue; // the default
    const label = FIELD_LABELS[key] || key;
    if (key === "has_food") {
      changes.push(`${label}: ${value ? "Байгаа" : "Байхгүй"}`);
    } else if (key === "status") {
      changes.push(`${label}: ${STATUS_LABELS[value as TripStatus] || String(value)}`);
    } else if (key === "photo_urls" && Array.isArray(value)) {
      // Raw Cloudinary URLs are unreadable noise — the count is what matters.
      if (value.length > 0) changes.push(`Зураг: ${value.length} ширхэг хавсаргана`);
    } else if (Array.isArray(value)) {
      changes.push(`${label}: ${value.join(", ")}`);
    } else if (typeof value === "object") {
      // Nested detail objects (extra) stringify to "[object Object]" — skip;
      // their real contents surface through the diff chips instead.
      continue;
    } else {
      changes.push(`${label}: ${String(value)}`);
    }
  }
  return { verb, target: String(target), changes };
}

/**
 * True when a question's detail text carries no information beyond the prompt
 * (same words, different punctuation/suffixes). Compared as word-token sets so
 * "«X» — нэмэх үү?" and "«X»-ыг нэмэх үү?" count as identical.
 */
export function isRedundantDetail(prompt: string, detail: string): boolean {
  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2),
    );
  const detailTokens = tokens(detail);
  if (detailTokens.size === 0) return true;
  const promptTokens = tokens(prompt);
  let covered = 0;
  for (const t of detailTokens) {
    if (promptTokens.has(t)) covered += 1;
  }
  return covered / detailTokens.size >= 0.85;
}

export function buildProposalClarifications(
  proposal: AIProposal,
  answeredIds: string[] = [],
  sourceNames: string[] = [],
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const seen = new Set(answeredIds);
  const coveredConflictChecks: Array<(normalized: string) => boolean> = [];

  function pushQuestion(question: ClarificationQuestion | null) {
    if (!question) return;
    if (seen.has(question.id)) return;
    seen.add(question.id);
    // Drop the detail line when it's just the prompt reworded — the raw model
    // conflict often IS the question ("«X» — шинэ аялал болгон нэмэх үү…?"),
    // and rendering both made every card twice as long to read for zero info.
    if (question.detail && isRedundantDetail(question.prompt, question.detail)) {
      question.detail = undefined;
    }
    questions.push(question);
  }

  proposal.actions.forEach((action, index) => {
    const fields = action.fields || {};
    const routeName =
      fields.route_name?.toString().trim() ||
      action.match?.route_name?.trim() ||
      `аялал ${index + 1}`;
    const adultPrice = typeof fields.adult_price === "number" ? fields.adult_price : null;
    const childPrice = typeof fields.child_price === "number" ? fields.child_price : null;
    const currency = typeof fields.currency === "string" ? fields.currency : undefined;
    if (adultPrice != null && childPrice != null && childPrice > adultPrice) {
      const routeKey = normalizeReviewText(routeName);
      coveredConflictChecks.push(
        (normalized) =>
          normalized.includes(routeKey) &&
          (normalized.includes("хүүхдийн үнэ") ||
            normalized.includes("child price") ||
            normalized.includes("том хүний үнэ")),
      );
      pushQuestion({
        id: `child-price:${routeName}`,
        prompt: `"${routeName}" аяллын хүүхдийн үнэ ${formatMoneyValue(childPrice, currency)} байгаа ч том хүний үнэ ${formatMoneyValue(adultPrice, currency)} байна. Ингэж үлдээх үү?`,
        options: [
          {
            label: "Тийм, ингэж үлдээх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}, том хүний үнийг ${adultPrice} гэж үлдээ.`,
          },
          {
            label: "Том хүний үнээр тэнцүүлэх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}-н оронд ${adultPrice} болгон өөрчил.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: `"${routeName}" аяллын зөв үнэ эсвэл зааварчилга бичнэ үү`,
      });
    }
  });

  const conflictSeverityMap = new Map<string, ConflictSeverity>();
  if (proposal.conflict_items && proposal.conflict_items.length > 0) {
    for (const item of proposal.conflict_items) {
      conflictSeverityMap.set(item.text.trim(), item.severity);
    }
  }

  const tripsWithDates = new Set<string>();
  for (const action of proposal.actions) {
    const f = action.fields || {};
    const dates = f.departure_dates;
    const hasRealDates =
      Array.isArray(dates) && dates.some((d) => String(d).trim().length > 2);
    if (hasRealDates) {
      const name = (f.route_name?.toString() || action.match?.route_name || "").trim().toLowerCase();
      if (name) tripsWithDates.add(name);
    }
  }

  proposal.conflicts.forEach((conflict, index) => {
    const detail = conflict.trim();
    if (!detail) return;
    const normalized = normalizeReviewText(detail);
    if (coveredConflictChecks.some((check) => check(normalized))) return;

    if (conflictSeverityMap.size > 0) {
      const severity = conflictSeverityMap.get(detail) ?? "blocker";
      if (severity !== "blocker") return;
    }

    // Incomplete parse: some trips were not read (timeout / failed batch) or
    // the model returned far fewer trips than the source contains. This MUST
    // block saving — never let a partial import look "ready".
    if (
      normalized.includes("аялал дутуу") ||
      normalized.includes("боловсруулсан") ||
      normalized.includes("уншиж амжсангүй") ||
      normalized.includes("уншиж чадсангүй") ||
      normalized.includes("дахин жижиг хэсг") ||
      normalized.includes("stopped before reading") ||
      normalized.includes("split the files")
    ) {
      pushQuestion({
        // Stable id (no conflict index): the model AND the code-side
        // completeness check often emit near-identical conflicts for the same
        // situation — indexed ids turned that into the same question asked
        // twice. One incomplete-parse decision is enough.
        id: "incomplete-parse",
        prompt: "Файлын зарим аялал боловсруулагдаагүй байна. Хэрхэн үргэлжлүүлэх вэ?",
        detail,
        options: [
          {
            label: "Болих — бүгдийг уншуулна",
            answer:
              "Энэ хагас дутуу импортыг бүү хадгал. Файлыг жижиг хэсгүүдэд (10-аас доош аялалтай) хувааж дахин оруулна.",
          },
          {
            label: "Зөвхөн уншсан аяллуудыг хадгалах",
            answer:
              "Зөвхөн одоо амжилттай уншсан аяллуудыг хадгал. Дутуу аяллуудыг дараа нь тусдаа оруулна гэдгийг ойлгосон.",
          },
        ],
        allowCustom: false,
      });
      return;
    }

    const quoted = extractQuotedValues(conflict);
    const subject = quoted[0] || "";
    const subjectTag = subject ? `"${subject}" аяллын ` : "";
    const isCompetingMainBrandConflict =
      (normalized.includes("хоёр өөр") ||
        normalized.includes("two different") ||
        normalized.includes("competing")) &&
      (normalized.includes("header") ||
        normalized.includes("лого") ||
        normalized.includes("logo") ||
        normalized.includes("толгой"));

    if (
      !isCompetingMainBrandConflict &&
      (isAgencyReviewText(subject) || isAgencyReviewText(detail))
    ) return;
    if (isOptionalAddOnCostConflict(normalized)) return;
    if (isDocumentedMealExceptionConflict(normalized)) return;
    if (isRecurringDateText(normalized)) return;
    if (normalized.includes("хүүхдийн үнэ") || normalized.includes("child price")) {
      if (!isSuspiciousChildPriceConflict(normalized)) return;
    }

    if (
      isCompetingMainBrandConflict ||
      normalized.includes("file") ||
      normalized.includes("файлын нэр") ||
      normalized.includes("operator") ||
      normalized.includes("оператор") ||
      normalized.includes("брэнд")
    ) {
      const detected = quoted[0] || "файлын нэр";
      const operator = quoted[1] || "илэрсэн оператор";
      if (
        (!isCompetingMainBrandConflict &&
          (normalized.includes("file") || normalized.includes("файлын нэр"))) ||
        isLikelyTripRouteText(detected) ||
        isLikelyTripRouteText(operator) ||
        (!isCompetingMainBrandConflict &&
          (isAgencyReviewText(detected) || isAgencyReviewText(operator)))
      ) {
        return;
      }
      pushQuestion({
        id: `operator-mismatch:${index}`,
        prompt: "Брэнд/операторын нэр зөрчилтэй байна. Аль нэрийг хэрэглэх вэ?",
        detail,
        options: [
          {
            label: `"${operator}" хэрэглэх`,
            answer: `Операторыг "${operator}" гэж үлдээнэ үү. (Зөрчил: ${detail})`,
          },
          {
            label: `"${detected}" хэрэглэх`,
            answer: `Операторыг "${detected}" болгоно уу. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Зөв оператор эсвэл брэндийн нэрийг бичнэ үү",
      });
      return;
    }

    if (normalized.includes("хөтөлбөртэй") && normalized.includes("чөлөөт")) {
      pushQuestion({
        id: `plan-choice:${index}`,
        prompt: `${subjectTag}хөтөлбөртэй болон чөлөөт гэсэн хоёр тусдаа үнийн хувилбар байна. Яаж хадгалах вэ?`,
        detail,
        options: [
          {
            label: "Тусдаа хоёр аялал",
            answer: `${subjectTag}хөтөлбөртэй болон чөлөөт хувилбарыг тусдаа хоёр аялал болгон хадгал. (Зөрчил: ${detail})`,
          },
          {
            label: "Зөвхөн хөтөлбөртэй",
            answer: `${subjectTag}зөвхөн хөтөлбөртэй хувилбарыг үндсэн аялал болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Зөвхөн чөлөөт",
            answer: `${subjectTag}зөвхөн чөлөөт хувилбарыг үндсэн аялал болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: хоёр хувилбарыг тусдаа хадгал, эсвэл нэгийг сонго",
      });
      return;
    }

    if (normalized.includes("хоол") || normalized.includes("meal") || normalized.includes("day 7")) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("хоол") || value.includes("meal")),
      );
      pushQuestion({
        id: `meal-conflict:${index}`,
        prompt: `${subjectTag}хоолны мэдээлэл зөрчилтэй байна. Хоол багтсан уу?`,
        detail,
        options: [
          {
            label: "Тийм, багтсан",
            answer: `${subjectTag}хоолыг багтсан гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Үгүй, багтаагүй",
            answer: `${subjectTag}хоолыг багтаагүй гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хоолны зөв дүрмийг бичнэ үү",
      });
      return;
    }

    if (isContradictoryDateConflict(detail)) return;

    if (
      normalized.includes("явах өдөр тодорхойгүй") ||
      normalized.includes("огноо") ||
      normalized.includes("departure date")
    ) {
      const hasPriceContext =
        detail.includes("₮") ||
        (normalized.includes("сард") && /\d{3,}/.test(detail));
      const subjectRouteName = normalizeReviewText(subject);
      const tripAlreadyHasDates =
        subjectRouteName.length > 3 && tripsWithDates.has(subjectRouteName);
      if (!hasPriceContext && !tripAlreadyHasDates) {
        const subjectKey = normalizeReviewText(subject || detail);
        coveredConflictChecks.push(
          (value) =>
            value.includes(subjectKey) &&
            (value.includes("огноо") || value.includes("departure date")),
        );
        pushQuestion({
          id: `date-conflict:${index}`,
          prompt: `${subjectTag}гарах өдрийг тодорхойлж чадсангүй. Юу хийх вэ?`,
          detail,
          options: [
            {
              label: "Огноогүй үлдээх",
              answer: `${subjectTag}гарах өдөргүйгээр саналд хэвээр нь үлдээ. (Зөрчил: ${detail})`,
            },
            {
              label: "Энэ аяллыг хасах",
              answer: `${subjectTag}гарах өдөр нь тодорхойгүй тул санал болгохгүй. (Зөрчил: ${detail})`,
            },
            {
              label: "Огноо доороос бичих",
              answer: `${subjectTag}гарах өдрийг доорх талбарт бичнэ үү.`,
            },
          ],
          allowCustom: true,
          customPlaceholder: "Гарах өдрийг бичнэ үү (ж: 2026-06-15, 2026-07-02)",
        });
        return;
      }
    }

    if (
      normalized.includes("юань") ||
      normalized.includes("cny") ||
      normalized.includes("валют")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("юань") || value.includes("cny") || value.includes("валют")),
      );
      pushQuestion({
        id: `currency-conflict:${index}`,
        prompt: `${subjectTag}үндсэн үнэ MNT, шинжилгээний нэмэлт төлбөр CNY байна. Яаж хадгалах вэ?`,
        detail,
        options: [
          {
            label: "MNT + CNY тэмдэглэл",
            answer: `${subjectTag}үндсэн үнийг MNT-ээр хадгалж, шинжилгээний CNY төлбөрийг тэмдэглэл/source_description-д тодорхой бич.`,
          },
          {
            label: "Админаар засуулах",
            answer: `${subjectTag}үнийн бүтэц тодорхойгүй тул хадгалахаас өмнө админаас яг adult/child MNT болон CNY нэмэлт төлбөрийг асуу.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: том хүн 890000 MNT + 600 CNY, хүүхэд 700000 MNT + 300 CNY",
      });
      return;
    }

    // Detect "price varies by date" conflicts by SHAPE, not fixed phrases —
    // the model phrases these differently every time ("6-р сард", "6 сарын
    // 20, 27:", "Том хүн 2,030,000₮ / Хүүхэд ..."). A real screenshot dump
    // ("6 сарын 20, 27: Том хүн 2,030,000₮ / Хүүхэд 1,590,000₮; 7 сарын 1, 8,
    // 15, 22: ...") matched NONE of the old fixed strings and fell through to
    // the meaningless generic fallback question.
    const mnPriceCount = (detail.match(/[\d,]+(?:,\d{3})*\s*(?:₮|төгрөг)/g) ?? []).length;
    const mentionsMonthDay = /\d+\s*сар(?:ын|д|ны)?\s*\d+/.test(detail);
    const isDateVaryingPriceDump = mnPriceCount >= 2 && (mentionsMonthDay || normalized.includes("сар"));
    if (
      normalized.includes("6-р сард") ||
      normalized.includes("7-р сард") ||
      normalized.includes("8-р сард") ||
      (normalized.includes("сард") && normalized.includes("үнэ")) ||
      isDateVaryingPriceDump
    ) {
      pushQuestion({
        id: `seasonal-price:${index}`,
        prompt: `${subjectTag}сараас хамаараад үнэ өөр байна. Яаж хадгалах вэ?`,
        detail,
        options: [
          {
            label: "Огноо тус бүрд үнийг тэмдэглэ (санал болгох)",
            answer: `${subjectTag}огноо бүрийн үнийг departure_dates дотор тус тусад нь тэмдэглэл/notes хэсэгт бич. Үндсэн adult_price-д хамгийн их үнийг тавь.`,
          },
          {
            label: "Тусдаа аялал болгох",
            answer: `${subjectTag}сар бүрийг тусдаа аялал болгон хадгал.`,
          },
          {
            label: "Хамгийн бага үнийг үндсэн болгох",
            answer: `${subjectTag}хамгийн бага үнийг үндсэн adult_price болгож, ялгааг notes хэсэгт тайлбарла.`,
          },
          {
            label: "Хамгийн их үнийг үндсэн болгох",
            answer: `${subjectTag}хамгийн их үнийг үндсэн adult_price болгож, буусан хямдралыг notes хэсэгт тайлбарла.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: 6-р сард 3,590,000 / 7,8-р сард 3,660,000 гэж тусад нь тэмдэглэ",
      });
      return;
    }

    if (
      normalized.includes("хоёр маршрут") ||
      normalized.includes("two route") ||
      normalized.includes("ижил")
    ) {
      pushQuestion({
        // Key by the trip named in the conflict (not the conflict's index) so
        // two differently-worded conflicts about the SAME route pair collapse
        // into one question, while different routes still each get asked.
        id: `duplicate-route:${normalizeReviewText(subject || detail).slice(0, 60)}`,
        prompt: "Ижил маршруттай боловч мэдээлэл нь зөрүүтэй хоёр аялал илэрлээ. Юу хийх вэ?",
        detail,
        options: [
          {
            label: "Тусдаа үлдээх",
            answer: `Эдгээрийг тусдаа аялал болгон үлдээ. (Зөрчил: ${detail})`,
          },
          {
            label: "Нэг болгон нэгтгэх",
            answer: `Эдгээрийг нэг аялал болгон нэгтгэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("batch failed") ||
      normalized.includes("upstream") ||
      normalized.includes("503")
    ) {
      return;
    }

    if (
      normalized.includes("нэмэлт шалгалт") ||
      normalized.includes("additional check") ||
      normalized.includes("review needed") ||
      normalized.includes("баталгаажуул")
    ) {
      return;
    }

    if (
      normalized.includes("аяллын нэр") ||
      normalized.includes("маршрутын нэр") ||
      normalized.includes("route name") ||
      normalized.includes("trip name")
    ) {
      pushQuestion({
        id: `trip-name:${index}`,
        prompt: subject
          ? `"${subject}" нэрийг энэ аялалд ашиглах уу?`
          : "Нэг аяллын нэр тодорхойгүй байна. Зөв нэрийг доорх талбарт яг бичнэ үү.",
        detail,
        options: [
          ...(subject
            ? [{
                label: `"${subject}" нэрээр хадгалах`,
                answer: `Аяллын нэрийг "${subject}" гэж хадгал. (Зөрчил: ${detail})`,
              }]
            : [{
                label: "Файл дээрх аяллын гарчгийг ашиглах",
                answer: `Файл дээр тухайн аяллын хэсгийн дээр бичсэн гарчгийг аяллын нэр болгон ашигла. (Зөрчил: ${detail})`,
              }]),
          {
            label: "Энэ аяллыг одоохондоо хадгалахгүй",
            answer: `Нэр нь тодорхойгүй энэ аяллыг саналын жагсаалтаас хас. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Зөв аяллын нэрийг яг бичнэ үү",
      });
      return;
    }

    // "add as new or update existing?" duplicate-check question
    if (
      normalized.includes("шинэ аялал болгон нэмэх үү") ||
      normalized.includes("одоо байгааг шинэчлэх үү") ||
      (normalized.includes("existing trip") && normalized.includes("duplicate")) ||
      (normalized.includes("review before creating") && normalized.includes("duplicate"))
    ) {
      const sourceLabel = sourceNames.length === 1 ? sourceNames[0] : "";
      const fileTag = sourceLabel ? ` · 📄 ${sourceLabel}` : "";
      pushQuestion({
        id: `add-or-update:${index}`,
        prompt: subject
          ? `"${subject}"${fileTag} — шинэ аялал болгон нэмэх үү, эсвэл одоо байгааг шинэчлэх үү?`
          : `Шинэ аялал нэмэх үү, эсвэл одоо байгааг шинэчлэх үү?${fileTag}`,
        detail,
        options: [
          {
            label: "Шинэ аялал болгон нэмэх",
            answer: subject
              ? `"${subject}"-г шинэ аялал болгон нэм. Одоо байгаа аялалыг бүү өөрчил.`
              : "Шинэ аялал болгон нэм. Одоо байгаа аялалыг бүү өөрчил.",
          },
          {
            label: "Одоо байгааг шинэчлэх",
            answer: subject
              ? `"${subject}"-г одоо байгаа аялалтай нэгтгэж шинэчил.`
              : "Одоо байгаа ижил аяллыг шинэчил.",
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
      });
      return;
    }

    // Price genuinely missing from the source (not a mismatch, not a date-
    // varying case — just no number found at all). Give it its own clear
    // question instead of the blank generic fallback.
    if (
      (normalized.includes("үнэ") || normalized.includes("price")) &&
      (normalized.includes("тодорхойгүй") ||
        normalized.includes("байхгүй") ||
        normalized.includes("unclear") ||
        normalized.includes("not found") ||
        normalized.includes("missing")) &&
      !/\d/.test(detail)
    ) {
      pushQuestion({
        id: `missing-price:${normalizeReviewText(subject || detail).slice(0, 60)}`,
        prompt: `${subjectTag}үнэ файлаас олдсонгүй. Юу хийх вэ?`,
        detail,
        options: [
          {
            label: "Үнэгүй хадгалах — дараа гараар нэмнэ",
            answer: `${subjectTag}үнийг хоосон орхиод хадгал. Үнийг дараа админ гараар нэмнэ.`,
          },
          {
            label: "Энэ аялалыг хадгалахгүй",
            answer: `${subjectTag}үнэ тодорхойгүй тул саналын жагсаалтаас хас.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Зөв үнийг доод шугамаар бичнэ үү (жишээ: 1590000)",
      });
      return;
    }

    // "Нэг аялалд ... хоёр өөр нэр таарсан" — two actions in this batch both
    // targeted the same existing trip but disagree on its name. Surface both
    // candidate names as tap options instead of the blank generic fallback.
    if (normalized.includes("хоёр өөр нэр таарсан")) {
      // The two candidate names are always the last two quoted values (the
      // current trip name, if present, is quoted first).
      const candidateNames = Array.from(new Set(quoted)).slice(-2);
      pushQuestion({
        id: `duplicate-name:${normalizeReviewText(detail).slice(0, 60)}`,
        prompt: "Нэг аялалд хоёр өөр нэр таарсан. Аль нэрийг хэрэглэх вэ?",
        detail,
        options: candidateNames.map((name) => ({
          label: `"${name}" гэж хадгалах`,
          answer: `Энэ аяллын нэрийг "${name}" гэж хадгал. (Зөрчил: ${detail})`,
        })),
        allowCustom: true,
        customPlaceholder: "Зөв аяллын нэрийг яг бичнэ үү",
      });
      return;
    }

    pushQuestion({
      id: `conflict:${index}`,
      prompt: "Энэ мэдээллийг хадгалахаас өмнө нэг шийдвэр хэрэгтэй байна.",
      detail,
      options: [
        {
          label: "Файлд бичсэн утгыг зөв гэж хадгалах",
          answer: `Файлд бичсэн утгыг зөв гэж үзээд хадгал: ${detail}`,
        },
        {
          label: "Энэ өөрчлөлтийг хадгалахгүй",
          answer: `Энэ тодорхойгүй өөрчлөлтийг саналын жагсаалтаас хас: ${detail}`,
        },
      ],
      allowCustom: true,
      customPlaceholder: "Зөв нэр, үнэ, огноо эсвэл хийх үйлдлийг яг бичнэ үү",
    });
  });

  return questions.slice(0, 4);
}
