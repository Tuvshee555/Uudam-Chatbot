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

/**
 * The uploaded file a piece was cut from: "Х.docx.part-002-of-002.txt", "Х.pdf.parsed-text-001-of-003.txt",
 * "Х.pdf.part-001.page-002.jpg", "Х.pdf.visual-page-001.jpg" and nested ones like
 * "Х.pdf.parsed-text-001-of-001.txt.part-001-of-002.txt" all → "Х.pdf".
 */
export function sourceFileBase(label: unknown): string {
  let base = text(label);
  for (let guard = 0; guard < 4; guard += 1) {
    const next = base
      .replace(/\.(?:part|parsed-text)-\d{1,4}(?:-of-\d{1,4})?(?:\.page-\d{1,4})?\.(?:txt|pdf|jpe?g|png)$/i, "")
      .replace(/\.visual-page-\d{1,4}\.(?:jpe?g|png)$/i, "");
    if (next === base) break;
    base = next;
  }
  return base.trim();
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nameKey = (value: unknown) => text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
const isEmpty = (value: unknown) => value == null || value === "" || (Array.isArray(value) && value.length === 0)
  || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Row).length === 0);
const facts = (fields: Row) => list(fields.departure_dates).length + list(record(fields.extra).price_groups).length
  + list(record(fields.extra).departure_date_groups).length + (Number(fields.adult_price) > 0 ? 1 : 0);
const programDays = (fields: Row) => list(record(fields.extra).itinerary_days).length;

const isNewTrip = (action: Row) => text(action.action).toLowerCase() === "upsert" && !text(action.trip_id);

/**
 * New trips read from pieces of ONE file under one name are one trip. A long file is read in parts
 * (text parts, a page picture); each part guesses its own length from what it saw (8, 9, 5 days), and
 * the July rule that keeps different-length trips apart (real 5- and 8-day versions) left three copies
 * of one trip on the card (2026-11-06; the three drafts were deleted 2026-11-14). The piece with the
 * most dates and prices is the base; the longest program and its length win; other facts fill in;
 * dates are combined. The card says so. Mutates the proposal.
 */
export function mergeSameFileNewTrips(proposal: AIChangeProposal): void {
  const actions = proposal.actions as unknown as Row[];
  const groups = new Map<string, Row[]>();
  for (const action of actions) {
    if (!isNewTrip(action)) continue;
    const fields = record(action.fields);
    const base = sourceFileBase(record(fields.extra).source_file_name);
    const name = nameKey(fields.route_name);
    if (!base || !name) continue;
    const key = `${base}|${name}`;
    groups.set(key, [...(groups.get(key) || []), action]);
  }
  const drop = new Set<Row>();
  const notes: string[] = [];
  for (const [key, pieces] of groups) {
    if (pieces.length < 2) continue;
    const ordered = [...pieces].sort((a, b) => facts(record(b.fields)) - facts(record(a.fields)));
    const program = [...pieces].sort((a, b) => programDays(record(b.fields)) - programDays(record(a.fields)))[0];
    const keep = ordered[0];
    const merged: Row = { ...record(keep.fields), extra: { ...record(record(keep.fields).extra) } };
    const extra = merged.extra as Row;
    for (const piece of ordered.slice(1)) {
      const fields = record(piece.fields);
      for (const [field, value] of Object.entries(fields)) {
        if (field === "extra") continue;
        if (field === "departure_dates" || field === "photo_urls") merged[field] = [...new Set([...list(merged[field]), ...list(value)].map(String))];
        else if (isEmpty(merged[field]) && !isEmpty(value)) merged[field] = value;
      }
      for (const [field, value] of Object.entries(record(fields.extra))) if (isEmpty(extra[field]) && !isEmpty(value)) extra[field] = value;
    }
    const programFields = record(program.fields);
    const programExtra = record(programFields.extra);
    if (programDays(programFields) > 0) {
      extra.itinerary_days = programExtra.itinerary_days;
      if (!isEmpty(programFields.duration_text)) merged.duration_text = programFields.duration_text;
      for (const field of ["duration_days", "duration_nights"]) if (!isEmpty(programExtra[field])) extra[field] = programExtra[field];
    }
    keep.fields = merged;
    for (const piece of pieces) if (piece !== keep) drop.add(piece);
    const lengths = [...new Set(pieces.map((piece) => text(record(piece.fields).duration_text)).filter(Boolean))];
    const file = key.slice(0, key.lastIndexOf("|"));
    notes.push(`«${file}» файлын ${pieces.length} хэсгээс уншсан «${text(merged.route_name)}»-ыг нэг аялал болголоо${lengths.length > 1 ? ` (хэсгүүд ${lengths.join(", ")} гэж уншсан)` : ""}. Хөтөлбөр, огноо, үнийг шалгана уу.`);
  }
  if (!drop.size) return;
  proposal.actions = actions.filter((action) => !drop.has(action)) as unknown as AIChangeProposal["actions"];
  const items: ConflictItem[] = notes.map((note) => ({ text: note, severity: "warning", type: "file_pieces_merged" }));
  proposal.conflict_items = [...(proposal.conflict_items || []), ...items];
  proposal.conflicts = [...(proposal.conflicts || []), ...items.map((item) => item.text)];
}
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
