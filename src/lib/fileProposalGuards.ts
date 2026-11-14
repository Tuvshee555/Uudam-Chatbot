/**
 * What a FILE reading may do to a trip that already exists.
 *
 * Why (2026-11-14, a real save): a long Word file for a NEW trip was cut into two parts by the page
 * (".part-001-of-002.txt", ".part-002-of-002.txt") and each part was read on its own. Part 1 became the
 * new trip; part 2 (no program, no title) was bound by name likeness to an older trip of the same city
 * and turned into a change of that trip — renamed, its departure dates and price rows replaced by none.
 * The admin saved the card; the older trip was archived for having no dates and left the website.
 *
 * Rules, for readings of files and pages (never for the admin's own typed instruction):
 *  - a part of a file that also makes a NEW trip never changes another trip (one file, one new trip);
 *  - a reading never renames an existing trip (a rename is the admin's own instruction);
 *  - a reading never empties an existing trip's departures or price rows.
 * Each removal is said on the card. Mutates the proposal in place. Pure otherwise.
 */
import type { AIChangeProposal, ConflictItem, TravelTrip } from "./travelTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** "Х.docx.part-002-of-002.txt" / "Х.pdf.parsed-text-001-of-003.txt" / "Х.pdf.part-001.page-002.jpg" → "Х.docx". */
export function sourceFileBase(label: unknown): string {
  return text(label)
    .replace(/\.(?:part|parsed-text)-\d{1,4}(?:-of-\d{1,4})?(?:\.page-\d{1,4})?\.(?:txt|pdf|jpe?g|png)$/i, "")
    .trim();
}

const isNewTrip = (action: Row) => text(action.action).toLowerCase() === "upsert" && !text(action.trip_id);
const changesTrip = (action: Row) => ["patch", "upsert", "cancel", "delete"].includes(text(action.action).toLowerCase()) && Boolean(text(action.trip_id));

export function guardFileProposal(proposal: AIChangeProposal, trips: TravelTrip[]): void {
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  const actions = proposal.actions as unknown as Row[];
  const newBases = new Set(actions.filter(isNewTrip).map((action) => sourceFileBase(record(record(action.fields).extra).source_file_name)).filter(Boolean));
  const notes: string[] = [];
  const kept: Row[] = [];
  for (const action of actions) {
    if (!changesTrip(action)) { kept.push(action); continue; }
    const trip = byId.get(text(action.trip_id));
    const name = trip ? `«${trip.route_name}»` : "одоо байгаа аялал";
    const fields = { ...record(action.fields) };
    const base = sourceFileBase(record(fields.extra).source_file_name);
    if (base && newBases.has(base)) {
      notes.push(`«${base}» файлын нэг хэсэг ${name}-ыг өөрчлөх санал гаргасныг хаслаа: нэг файлаас нэг шинэ аялал үүснэ, хуучин аялал хөндөгдөхгүй.`);
      continue;
    }
    if (trip && text(fields.route_name) && text(fields.route_name) !== trip.route_name) {
      notes.push(`${name}-ын нэрийг «${text(fields.route_name)}» болгох саналыг хаслаа: файл уншихад аяллын нэр солигдохгүй (нэр солих бол туслахад шууд бичнэ үү).`);
      delete fields.route_name;
      const extra = { ...record(fields.extra) };
      delete extra.tour_title;
      fields.extra = extra;
    }
    if (trip && Array.isArray(fields.departure_dates) && !fields.departure_dates.length && trip.departure_dates.length) {
      notes.push(`${name}-ын бүх гарах өдрийг устгах саналыг хаслаа.`);
      delete fields.departure_dates;
    }
    for (const key of ["price_groups", "departure_date_groups"]) {
      const extra = record(fields.extra);
      if (Array.isArray(extra[key]) && !(extra[key] as unknown[]).length && Array.isArray(record(trip?.extra)[key]) && (record(trip?.extra)[key] as unknown[]).length) {
        const next = { ...extra };
        delete next[key];
        fields.extra = next;
        notes.push(`${name}-ын үнийн мөрүүдийг хоосон болгох саналыг хаслаа.`);
      }
    }
    const meaningful = Object.keys(fields).filter((key) => key !== "extra" || Object.keys(record(fields.extra)).some((inner) => inner !== "source_file_name"));
    if (text(action.action).toLowerCase() === "patch" && !meaningful.length) continue;
    kept.push({ ...action, fields });
  }
  if (!notes.length) return;
  proposal.actions = kept as unknown as AIChangeProposal["actions"];
  const items: ConflictItem[] = [...new Set(notes)].map((note) => ({ text: note, severity: "warning", type: "file_change_removed" }));
  proposal.conflict_items = [...(proposal.conflict_items || []), ...items];
  proposal.conflicts = [...(proposal.conflicts || []), ...items.map((item) => item.text)];
}
