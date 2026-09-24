import { normText } from "./travelFastPathsSearch";

function hasQuestionMarker(normalized: string): boolean {
  if (/[?？]/.test(normalized)) return true;
  return /(?:\b(?:хэд|hed|үнэ|une|суудал\s+байгаа|байгаа\s+юу|baina\s+uu|bnu|yu|ve|uu)\b|(?:уу|үү|юу|вэ)\s*$)/i.test(normalized);
}

/**
 * Staff sometimes paste catalog/status rows into Messenger while testing:
 * "10 сарын 8-ны <хот> суудал дүүрсэн - 5 шөнө 6 өдөртэй".
 *
 * That is not a customer question. If we let it fall through, permissive
 * price/budget matchers can interpret the duration number as a budget ("5 сая")
 * or quote a near-name sibling. Keep this deliberately narrow so real customer
 * questions like "суудал дүүрсэн үү?" still get answered.
 */
export function isLikelyCatalogMaintenanceText(text: string): boolean {
  const normalized = normText(text);
  if (!normalized || hasQuestionMarker(normalized)) return false;
  const raw = text.trim();

  const hasDate =
    /\b\d{1,2}\s*\/\s*\d{1,2}\b/.test(raw) ||
    /\b\d{1,2}\s*(?:-?р\s*)?сарын\s+\d{1,2}\b/.test(raw) ||
    /\b\d{1,2}\s*(?:-?р\s*)?сарын\s+\d{1,2}\b/.test(normalized);
  const hasClosedSeats =
    /суудал(?:\s+нь)?\s+(?:дүүрсэн|дууссан|байхгүй)|sold\s*out/i.test(normalized);
  const hasDuration =
    /(?:^|\s)\d{1,2}\s*(?:шөнө|өдөр|хоног|honog|udur|shunu)/i.test(normalized);
  const hasMaintenanceSeparator = /\s[-–—:]\s/.test(raw) || /\b(?:гэсэн|gedeg|тэмдэглэл|status)\b/i.test(normalized);

  return hasDate && hasClosedSeats && hasDuration && hasMaintenanceSeparator;
}
