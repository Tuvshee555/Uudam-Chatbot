import { sameParityValue } from "./tripWebsiteParityValue";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const websiteDetailFields = [
  { key: "country", label: "Улс", type: "text" },
  { key: "city", label: "Хот", type: "text" },
  { key: "region", label: "Бүс", type: "text" },
  { key: "destinations", label: "Очих газрууд", type: "list" },
  { key: "transport", label: "Тээвэр", type: "list" },
  { key: "languages", label: "Хэл", type: "list" },
  { key: "meetingPoint", label: "Уулзах газар", type: "text" },
  { key: "mapUrl", label: "Газрын зураг", type: "text" },
  { key: "season", label: "Улирал", type: "text" },
  { key: "difficulty", label: "Хүндрэл", type: "text" },
  { key: "minTravelers", label: "Хамгийн бага хүн", type: "number" },
  { key: "maxTravelers", label: "Хамгийн их хүн", type: "number" },
  { key: "oldPrice", label: "Өмнөх үнэ", type: "number" },
  { key: "discount", label: "Хямдрал (%)", type: "number" },
  { key: "singleSupplement", label: "Нэг хүний өрөөний нэмэгдэл", type: "number" },
  { key: "brochurePdfUrl", label: "Танилцуулгын PDF", type: "text" },
  { key: "isFeatured", label: "Онцлох аялал", type: "boolean" },
  { key: "highlights", label: "Онцлох мөчүүд", type: "list" },
  { key: "requirements", label: "Шаардлага", type: "text" },
  { key: "cancellationPolicy", label: "Цуцлалтын нөхцөл", type: "text" },
  { key: "extraFees", label: "Веб нэмэлт төлбөр", type: "list" },
  { key: "roomPrices", label: "Веб өрөөний үнэ", type: "list" },
  { key: "childPriceNotes", label: "Хүүхдийн үнийн тэмдэглэл", type: "list" },
  { key: "video", label: "Бичлэгийн URL", type: "text" },
  { key: "videos", label: "Нэмэлт бичлэгүүд", type: "list" },
  { key: "hotelMedia", label: "Буудлын зураг, бичлэг", type: "media" },
  { key: "travelerMedia", label: "Аялагчдын зураг, бичлэг", type: "media" },
] as const;

export function websiteDetailsSnapshot(value: unknown): Row {
  const trip = record(value);
  return { ...Object.fromEntries([...websiteDetailFields.map((field) => field.key), "title", "description", "summary", "slug", "weather", "updatedAt", "isPublished", "itinerary", "price", "childPrice", "infantPrice", "currency"].map((key) => [key, trip[key] ?? null])), contentConflicts: record(trip.sourceMetadata).contentConflicts || [] };
}

export function websiteDetailsPatch(before: unknown, after: unknown): { base: Row; values: Row } {
  const base = record(before), edited = record(after);
  const values = Object.fromEntries(websiteDetailFields.filter(({ key }) => key in edited && !sameParityValue(base[key], edited[key])).map(({ key }) => [key, edited[key]]));
  return { base, values };
}

/** Only known editorial fields may reach SQL, with per-field stale-edit protection. */
export function applyWebsiteDetailsPatch(current: unknown, patch: unknown) {
  const website = record(current), edit = record(patch), base = record(edit.base), values = record(edit.values);
  const data: Row = {}, conflicts: Row[] = [];
  for (const field of websiteDetailFields) {
    if (!(field.key in values)) continue;
    const value = values[field.key];
    if (field.type === "number" && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value))) throw new Error(`Invalid website number: ${field.key}`);
    if (["minTravelers", "maxTravelers"].includes(field.key) && value != null && Number(value) < 1) throw new Error(`Invalid traveler count: ${field.key}`);
    if (field.key === "minTravelers" && value === null) throw new Error("Minimum traveler count is required");
    if (field.key === "discount" && value != null && Number(value) > 100) throw new Error("Invalid discount percentage");
    if (field.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid website flag: ${field.key}`);
    if (field.type === "text" && value !== null && (typeof value !== "string" || value.length > 4000)) throw new Error(`Invalid website field: ${field.key}`);
    if (field.type === "list" && (!Array.isArray(value) || value.length > 120 || value.some((item) => typeof item !== "string" || item.length > 1000))) throw new Error(`Invalid website list: ${field.key}`);
    if (field.type === "media" && (!Array.isArray(value) || value.length > 120 || value.some((item) => typeof record(item).url !== "string" || !/^https?:\/\//i.test(String(record(item).url)) || String(record(item).url).length > 1000 || typeof record(item).caption !== "string"))) throw new Error(`Invalid website media: ${field.key}`);
    if (["video", "mapUrl", "brochurePdfUrl"].includes(field.key) && value && !/^https?:\/\//i.test(String(value))) throw new Error(`Invalid website URL: ${field.key}`);
    if (sameParityValue(website[field.key], base[field.key]) || sameParityValue(website[field.key], value)) data[field.key] = value;
    else conflicts.push({ field: `website.${field.key}`, website: website[field.key] ?? null, chatbot: value, base: base[field.key] ?? null });
  }
  const min = Number(data.minTravelers ?? website.minTravelers ?? 1), max = data.maxTravelers === null ? null : data.maxTravelers ?? website.maxTravelers;
  if (("minTravelers" in data || "maxTravelers" in data) && max != null && Number(max) < min) throw new Error("Maximum traveler count must not be below minimum");
  return { data, conflicts };
}

/** Existing differences stay separate; a shared save never picks a winner. */
export function mergeWebsiteContent(current: Row, baseline: Row, incoming: Row) {
  const data: Row = {}, conflicts: Row[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (sameParityValue(current[key], value) || sameParityValue(current[key], baseline[key])) data[key] = value;
    else conflicts.push({ field: key, website: current[key] ?? null, chatbot: value, base: baseline[key] ?? null });
  }
  return { data, conflicts };
}
