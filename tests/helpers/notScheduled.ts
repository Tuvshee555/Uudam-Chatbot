/**
 * "Nothing leaves at the asked time" replies, both wordings: the old "Тэр хугацаанд гарах аялал алга.
 * Гарах өдрүүд:" (a time the parser cannot place) and the nearest-dates reply that names the asked time
 * ("2 сарын 20-нд гарах аялал алга.\nХамгийн ойр гарах өдрүүд:", dateAlternatives.ts, 2026-11-13).
 * Negative checks use NOT_SCHEDULED_RE so they keep guarding against either wording.
 */
export const NOT_SCHEDULED_RE = /(?:Тэр хугацаанд|-нд|-ны хооронд|сард) гарах аялал алга\./u;
export const NOT_SCHEDULED_LIST_START = /^(?:Тэр хугацаанд гарах аялал алга\. Гарах өдрүүд:|[^\n]*(?:-нд|-ны хооронд|сард) гарах аялал алга\.\nХамгийн ойр гарах өдрүүд:)/u;
