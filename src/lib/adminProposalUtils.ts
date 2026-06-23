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
  route_name: "Маршрут",
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
  if (
    normalized.includes("6-р сард") ||
    normalized.includes("7-р сард") ||
    normalized.includes("8-р сард")
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
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    const label = FIELD_LABELS[key] || key;
    if (key === "has_food") {
      changes.push(`${label}: ${value ? "Байгаа" : "Байхгүй"}`);
    } else if (key === "status") {
      changes.push(`${label}: ${STATUS_LABELS[value as TripStatus] || String(value)}`);
    } else if (key === "departure_dates" && Array.isArray(value)) {
      changes.push(`${label}: ${value.join(", ")}`);
    } else {
      changes.push(`${label}: ${String(value)}`);
    }
  }
  return { verb, target: String(target), changes };
}

export function buildProposalClarifications(
  proposal: AIProposal,
  answeredIds: string[] = [],
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const seen = new Set(answeredIds);
  const coveredConflictChecks: Array<(normalized: string) => boolean> = [];

  function pushQuestion(question: ClarificationQuestion | null) {
    if (!question) return;
    if (seen.has(question.id)) return;
    seen.add(question.id);
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

    const quoted = extractQuotedValues(conflict);
    const subject = quoted[0] || "";
    const subjectTag = subject ? `"${subject}" аяллын ` : "";

    if (isAgencyReviewText(subject) || isAgencyReviewText(detail)) return;
    if (isOptionalAddOnCostConflict(normalized)) return;
    if (isDocumentedMealExceptionConflict(normalized)) return;
    if (isRecurringDateText(normalized)) return;
    if (normalized.includes("хүүхдийн үнэ") || normalized.includes("child price")) {
      if (!isSuspiciousChildPriceConflict(normalized)) return;
    }

    if (
      normalized.includes("file") ||
      normalized.includes("файлын нэр") ||
      normalized.includes("operator") ||
      normalized.includes("оператор") ||
      normalized.includes("брэнд")
    ) {
      const detected = quoted[0] || "файлын нэр";
      const operator = quoted[1] || "илэрсэн оператор";
      if (
        normalized.includes("file") ||
        normalized.includes("файлын нэр") ||
        isLikelyTripRouteText(detected) ||
        isLikelyTripRouteText(operator) ||
        isAgencyReviewText(detected) ||
        isAgencyReviewText(operator)
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

    if (
      normalized.includes("6-р сард") ||
      normalized.includes("7-р сард") ||
      normalized.includes("8-р сард") ||
      (normalized.includes("сард") && normalized.includes("үнэ"))
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
        id: `duplicate-route:${index}`,
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

    pushQuestion({
      id: `conflict:${index}`,
      prompt: `Дараах зөрчлийг хэрхэн зохицуулах вэ? ${detail}`,
      options: [
        {
          label: "Илэрсэнээр нь үлдээх",
          answer: `Дараах зөрчлийг илэрсэн хэвээр нь үлдээ: ${detail}`,
        },
        {
          label: "Болгоомжтой засах",
          answer: `Дараах зөрчлийг болгоомжтой хянаж засна уу: ${detail}`,
        },
      ],
      allowCustom: true,
      customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
    });
  });

  return questions.slice(0, 4);
}
