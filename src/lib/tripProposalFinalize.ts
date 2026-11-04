/**
 * What turns the model's reading of a file into a trip the website can show as if
 * staff had added it there: the standard Ulaanbaatar days for the trip's transport
 * type (tripTransitDays.ts), the website's transport tags, a clickable transport
 * choice in the proposal, and at least PHOTOS_PER_TRIP photos — the file's own, or
 * free ones found for the places the trip visits (tripPhotoFinder.ts), each with
 * its credit. Runs on every proposal: when it is first built and again after each
 * clarification answer, so choosing another transport rebuilds the days.
 */
import type { AIChangeProposal, AITripAction, ConflictItem } from "./travelTypes";
import { askOpenAIChatParts } from "./openaiFallback";
import { logWarn } from "./observability";
import { uploadImageToCloudinary } from "./tripPhotoImport/upload";
import { MIN_TRIP_PRICE_MNT, PRICE_MISSING, PRICE_QUESTION_MARK, mentionsPartnerPrice, parseMntPrices, withoutPartnerPrices } from "./tripPriceRules";
import {
  PHOTOS_PER_TRIP, collectPhotoCandidates, downloadPhoto, photoQueriesForTrip, rankPhotos, type FoundPhoto,
} from "./tripPhotoFinder";
import {
  TRANSPORT_CHOICE, TRANSPORT_LABELS, TRANSPORT_WEBSITE_TAGS, detectTransportType, durationForDays, isTransitDay, isTransportType,
  withStandardTransitDays, type ItineraryDay, type TransportType,
} from "./tripTransitDays";

type Row = Record<string, unknown>;
type Trace = { requestId?: string; correlationId?: string };
export type PhotoDeps = {
  ask?: typeof askOpenAIChatParts;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  upload?: (buffer: Buffer, fileName: string, mimeType: string) => Promise<string>;
  /** Stop looking for more photos after this long (the parse route has a 180 s budget). */
  budgetMs?: number;
};

const PHOTO_PROVIDER = "Wikimedia Commons";
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const sameRoute = (a: unknown, b: unknown) => text(a).toLowerCase().replace(/\s+/g, " ") === text(b).toLowerCase().replace(/\s+/g, " ");

function routeName(action: AITripAction): string {
  return text(action.fields?.route_name) || text(action.match?.route_name);
}

/** The actions that create a trip (not a patch of an existing one). */
export function newTripActions(proposal: AIChangeProposal): AITripAction[] {
  return proposal.actions.filter((action) => action.action === "upsert" && !text(action.trip_id) && action.fields);
}

/**
 * The transport the admin clicked, carried in the answer as `(transport_type=…)`, applied
 * to the named trip (or every new trip when none is named). True when something changed.
 */
export function applyTransportChoice(clarification: string, proposal: AIChangeProposal): boolean {
  const match = /transport_type=(land_flight|direct_flight|land|cruise)/.exec(clarification || "");
  if (!match) return false;
  const transport = match[1] as TransportType;
  const quoted = /[«"]([^»"]+)[»"]/.exec(clarification)?.[1];
  const targets = newTripActions(proposal).filter((action) => !quoted || sameRoute(routeName(action), quoted));
  for (const action of targets) {
    const fields = action.fields as Row;
    const extra = record(fields.extra);
    fields.extra = { ...extra, transport_type: transport };
  }
  return targets.length > 0;
}

function dropConflictItem(proposal: AIChangeProposal, type: string, route: string) {
  proposal.conflict_items = (proposal.conflict_items || []).filter((entry) => !(entry.type === type && sameRoute(record(entry.data).route_name, route)));
}

const PRICE_FIELDS = ["adult_price", "child_price", "infant_price"] as const;
const PARTNER_DURATION = /\d+\s*өдөр[\s/,]*\d+\s*шөнө|\d+\s*шөнө[\s/,]*\d+\s*өдөр/gi;
const PARTNER_PRICE_JSON = /юан|¥|\bCNY\b|\bRMB\b|ланд|лант|газрын\s+үнэ/i;
const MODEL_PRICE_NOTICE = /төгрөгийн үнэ файлд байхгүй/i;

/**
 * Owner's rule (tripPriceRules.ts): no yuan or land price on a new trip — not as its fare,
 * not in its notes, summary or price table, not in the proposal's one-line summary. A fare
 * in another currency, or a "₮" figure too small to be a trip (a yuan amount misread), is
 * cleared; the admin is then asked for the tugrug price.
 */
export function scrubPartnerPrices(proposal: AIChangeProposal): void {
  if (typeof proposal.summary === "string" && proposal.summary.trim()) {
    proposal.summary = withoutPartnerPrices(proposal.summary) || "Файлаас аяллын мэдээлэл уншлаа.";
  }
  const actions = newTripActions(proposal);
  if (!actions.length) return;
  for (const action of actions) {
    const fields = action.fields as Row;
    const currency = text(fields.currency).toUpperCase();
    const foreign = Boolean(currency) && currency !== "MNT" && currency !== "₮";
    for (const key of PRICE_FIELDS) {
      const value = fields[key];
      if (typeof value === "number" && (foreign ? value !== 0 : value > 0 && value < MIN_TRIP_PRICE_MNT)) fields[key] = null;
    }
    if (foreign) fields.currency = "MNT";
    for (const key of ["notes", "source_description"]) if (typeof fields[key] === "string") fields[key] = withoutPartnerPrices(fields[key]);
    const extra = record(fields.extra);
    if (Object.keys(extra).length) {
      const next: Row = { ...extra };
      for (const key of ["website_summary", "description"]) if (typeof next[key] === "string") next[key] = withoutPartnerPrices(next[key]);
      if (Array.isArray(next.price_groups)) next.price_groups = next.price_groups.filter((group) => !PARTNER_PRICE_JSON.test(JSON.stringify(group)));
      fields.extra = next;
    }
  }
  // The model's own "no tugrug price" notes and partner-price remarks: the price question replaces them.
  proposal.conflict_items = (proposal.conflict_items || []).filter((item) => item.type === PRICE_MISSING
    || !(MODEL_PRICE_NOTICE.test(item.text) || (item.severity !== "blocker" && mentionsPartnerPrice(item.text))));
  proposal.conflicts = (proposal.conflicts || []).filter((item) => !MODEL_PRICE_NOTICE.test(item) && !mentionsPartnerPrice(item));
}

/**
 * The tugrug price typed into the price question ("«trip» аяллын төгрөгийн үнийг бичнэ үү … →
 * 3,290,000 / 2,590,000"): first amount adult, second child. True when a fare was set.
 */
export function applyPriceAnswer(clarification: string, proposal: AIChangeProposal): boolean {
  let changed = false;
  const actions = newTripActions(proposal);
  for (const line of String(clarification || "").split(/\n/)) {
    if (!line.includes(PRICE_QUESTION_MARK)) continue;
    const arrow = line.lastIndexOf("→");
    if (arrow < 0) continue;
    const prices = parseMntPrices(line.slice(arrow + 1));
    if (!prices.length) continue;
    const route = /«([^»]+)»/.exec(line.slice(0, arrow))?.[1];
    let targets = actions.filter((action) => route && sameRoute(routeName(action), route));
    if (!targets.length && actions.length === 1) targets = actions;
    for (const action of targets) {
      const fields = action.fields as Row;
      fields.adult_price = prices[0];
      if (prices[1] != null) fields.child_price = prices[1];
      fields.currency = "MNT";
      changed = true;
    }
  }
  return changed;
}

function setConflictItem(proposal: AIChangeProposal, item: ConflictItem, route: string) {
  const items = (proposal.conflict_items || []).filter((entry) => !(entry.type === item.type && sameRoute(record(entry.data).route_name, route)));
  proposal.conflict_items = [...items, item];
}

/**
 * Credits and day photos the previous proposal held, restored onto the revised one
 * (the model never sees photo data, so a revision comes back without them).
 */
export function carryOverPhotoExtras(previous: AIChangeProposal, revised: AIChangeProposal): void {
  for (const action of newTripActions(revised)) {
    const before = newTripActions(previous).find((candidate) => sameRoute(routeName(candidate), routeName(action)));
    if (!before) continue;
    const fields = action.fields as Row;
    const extra = { ...record(fields.extra) };
    const previousExtra = record(before.fields?.extra);
    if (!Object.keys(record(extra.photo_credits)).length && Object.keys(record(previousExtra.photo_credits)).length) {
      extra.photo_credits = previousExtra.photo_credits;
    }
    const previousDays = Array.isArray(previousExtra.itinerary_days) ? previousExtra.itinerary_days.map(record) : [];
    if (Array.isArray(extra.itinerary_days) && previousDays.length) {
      extra.itinerary_days = extra.itinerary_days.map((entry) => {
        const day = record(entry);
        if (text(day.photo)) return day;
        const match = previousDays.find((old) => text(old.photo) && sameRoute(old.title, day.title));
        return match ? { ...day, photo: match.photo } : day;
      });
    }
    fields.extra = extra;
  }
}

function countPhotos(fields: Row, days: ItineraryDay[]): number {
  const urls = new Set((Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((url): url is string => typeof url === "string"));
  for (const day of days) if (text(day.photo)) urls.add(text(day.photo));
  return urls.size;
}

async function fillPhotos(input: { action: AITripAction; route: string; days: ItineraryDay[]; deps: PhotoDeps; trace?: Trace }): Promise<{ added: number; message: string | null }> {
  const { action, route, days, deps } = input;
  const fields = action.fields as Row;
  const extra = record(fields.extra);
  const have = countPhotos(fields, days);
  const missing = PHOTOS_PER_TRIP - have;
  if (missing <= 0) return { added: 0, message: null };
  const startedAt = Date.now();
  const budgetMs = deps.budgetMs ?? 60_000;
  const upload = deps.upload || uploadImageToCloudinary;
  const programDays = days.filter((day) => !isTransitDay(day));
  const queries = await photoQueriesForTrip({ title: route, days: programDays,
    destinations: Array.isArray(extra.destinations) ? extra.destinations.map(String) : undefined, ask: deps.ask, trace: input.trace });
  if (!queries.length) return { added: 0, message: null };
  const dayOfQuery = new Map(queries.map((query) => [query.query, query.day]));
  const candidates = await collectPhotoCandidates(queries.map((query) => query.query), { perQuery: 6, fetchImpl: deps.fetchImpl });
  const chosen = await rankPhotos(candidates, { subject: `${route}: ${queries.map((query) => query.query).join(", ")}`, count: missing,
    fetchImpl: deps.fetchImpl, ask: deps.ask, trace: input.trace });
  const urls: string[] = [];
  const credits = { ...record(extra.photo_credits) };
  const placed: Array<{ photo: FoundPhoto; url: string }> = [];
  for (const photo of chosen) {
    if (Date.now() - startedAt > budgetMs) break;
    const file = await downloadPhoto(photo, deps.fetchImpl);
    if (!file) continue;
    try {
      const url = await upload(file.buffer, `${photo.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) || "photo"}.jpg`, file.mimeType);
      urls.push(url);
      credits[url] = { title: photo.title, author: photo.author, license: photo.license, page: photo.pageUrl, provider: PHOTO_PROVIDER };
      placed.push({ photo, url });
    } catch (error) {
      logWarn("trip_photos.upload_failed", { route, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!urls.length) return { added: 0, message: null };
  const existing = (Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((url): url is string => typeof url === "string");
  fields.photo_urls = Array.from(new Set([...existing, ...urls])).slice(0, 20);
  // Each found photo goes onto the day whose sight it shows; transit days never get one.
  const withPhotos = days.map((day) => ({ ...day }));
  for (const { photo, url } of placed) {
    const dayNumber = dayOfQuery.get(photo.query);
    const day = withPhotos.find((entry) => entry.day === dayNumber && !isTransitDay(entry) && !text(entry.photo));
    if (day) day.photo = url;
  }
  fields.extra = { ...extra, itinerary_days: withPhotos, photo_credits: credits };
  return { added: urls.length, message: `«${route}»: ${PHOTO_PROVIDER}-оос ${urls.length} зураг нэмэв (зохиогч, лицензийг хадгалсан). Таалагдахгүй зургийг хадгалсны дараа «Зураг оруулах» хэсгээс солино.` };
}

/**
 * Finalises every new trip in the proposal. `photos` turns on the photo search (the
 * initial proposal); a revision passes nothing and keeps the photos it carried over.
 */
export async function finalizeNewTripActions(proposal: AIChangeProposal, options: { photos?: PhotoDeps; trace?: Trace } = {}): Promise<void> {
  scrubPartnerPrices(proposal);
  for (const action of newTripActions(proposal)) {
    const fields = action.fields as Row;
    const route = routeName(action);
    const extra = record(fields.extra);
    const days = (Array.isArray(extra.itinerary_days) ? extra.itinerary_days : []).map((entry) => record(entry) as ItineraryDay);
    if (!days.length || !route) continue;
    try {
      const detected = detectTransportType({ title: route, route: text(extra.route), notes: text(fields.notes), days,
        transportType: isTransportType(extra.transport_type) ? extra.transport_type : undefined, transport: extra.transport });
      const built = withStandardTransitDays(days, detected.transport);
      const patch = record(extra.website_details_patch);
      fields.extra = {
        ...extra,
        itinerary_days: built.days,
        transport_type: detected.transport,
        website_details_patch: { base: record(patch.base), values: { ...record(patch.values), transport: TRANSPORT_WEBSITE_TAGS[detected.transport] } },
        ...(built.added > 0 ? { duration_days: durationForDays(built.days.length).duration_days, duration_nights: durationForDays(built.days.length).duration_nights } : {}),
      };
      if (built.added > 0) {
        // The partner's own length ("7 өдөр 6 шөнө") left in the summaries would contradict the
        // door-to-door duration the trip now has (seen on a real file, 2026-11-04).
        const total = durationForDays(built.days.length).duration_text;
        fields.duration_text = total;
        const current = record(fields.extra);
        if (typeof current.website_summary === "string") fields.extra = { ...current, website_summary: current.website_summary.replace(PARTNER_DURATION, total) };
        if (typeof proposal.summary === "string") proposal.summary = proposal.summary.replace(PARTNER_DURATION, total);
      }
      const duration = durationForDays(built.days.length);
      setConflictItem(proposal, {
        text: `«${route}» — тээвэр: ${TRANSPORT_LABELS[detected.transport]}.${built.added > 0 ? ` Улаанбаатараас гарах, буцах өдрүүдийг стандартаар нэмсэн: нийт ${duration.duration_text}.` : ""} Буруу бол тээврийн төрлийг доороос сонгоно уу.`,
        severity: "info",
        type: TRANSPORT_CHOICE,
        data: { route_name: route, transport_type: detected.transport, sure: detected.sure, added: built.added },
      }, route);
      if (built.added > 0 || !detected.sure) {
        proposal.needs_confirmation = true;
        if (!text(proposal.important_reason)) proposal.important_reason = "Тээврийн төрөл болон Улаанбаатараас гарах, буцах өдрүүдийг шалгана уу.";
      }
      // What the admin still has to add by hand, said once in the proposal.
      if (typeof fields.adult_price !== "number") {
        setConflictItem(proposal, { text: `«${route}»: файлд төгрөгийн зарах үнэ алга (юань, ландын үнийг үнэ гэж авахгүй). Үнээ бичнэ үү, эсвэл дараа «Аяллууд» хэсгээс нэмнэ — тэр хүртэл сайтад «Үнэ лавлах» гэж гарна.`, severity: "info", type: PRICE_MISSING, data: { route_name: route } }, route);
        proposal.needs_confirmation = true;
      } else {
        dropConflictItem(proposal, PRICE_MISSING, route);
      }
      const dates = Array.isArray(fields.departure_dates) ? fields.departure_dates.filter((date) => text(date)) : [];
      if (!dates.length) {
        setConflictItem(proposal, { text: `«${route}»: гарах өдөр файлд олдсонгүй — огноо нэмтэл аялал архивт хадгалагдана.`, severity: "info", type: "dates_missing", data: { route_name: route } }, route);
      } else if (built.added > 0) {
        setConflictItem(proposal, { text: `«${route}»: файлын огноо (${dates.slice(0, 3).join(", ")}) хамтрагчийн хөтөлбөрийн Эрээн дэх эхний өдөр бол Улаанбаатараас нэг өдрийн өмнө гарна — гарах өдрийг шалгана уу.`, severity: "info", type: "dates_check", data: { route_name: route } }, route);
      }
      if (options.photos) {
        const result = await fillPhotos({ action, route, days: built.days, deps: options.photos, trace: options.trace });
        if (result.message) setConflictItem(proposal, { text: result.message, severity: "info", type: "photos_found", data: { route_name: route, added: result.added } }, route);
      }
    } catch (error) {
      logWarn("trip_proposal.finalize_failed", { route, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
