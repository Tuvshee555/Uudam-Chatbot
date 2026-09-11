import { createHash } from "crypto";
import { savePosterTrip } from "../../src/lib/poster/db";
import { patchTrip } from "../../src/lib/travelDb";
import { queryNeon } from "../../src/lib/neonDb";
import { uploadImageToCloudinary } from "../../src/lib/tripPhotoImport/upload";

export type SourceTripImport = {
  posterId: string;
  title: string;
  sourceUrl: string;
  operator?: string;
  durationText: string;
  dates: string[];
  adultPrice?: number | null;
  childPrice?: number | null;
  infantPrice?: number | null;
  hotel?: string;
  photoQueries: string[];
  days: Array<{ title: string; description: string }>;
  includes?: string[];
  excludes?: string[];
  reviewReasons?: string[];
};

type Photo = {
  url: string;
  source: string;
  title: string;
  hash: string;
  query: string;
};

const BAD_PHOTO =
  /airport|airplane|aircraft|flight|train|railway|station|locomotive|bus|subway|metro|platform|tram|taxi|car|traffic|hotel|lobby|room|mall|shop|store|restaurant|people|selfie|portrait|crowd|meeting|conference|map|sign|logo|svg|icon|diagram|satellite|modis|runway|terminal|interior|beer|bottle|table|view from|aerial|construction|storm|cyclone|\bLHT\b|learjet|welcome home|navy|osborn/i;

function slug(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "trip";
}

async function existingPhotoKeys() {
  const rows = await queryNeon<{ photo_urls: string[] | null; extra: Record<string, unknown> | null }>(
    `SELECT photo_urls, extra FROM travel_trip_entries`,
  );
  const urls = new Set<string>();
  const hashes = new Set<string>();
  for (const row of rows?.rows ?? []) {
    for (const url of row.photo_urls ?? []) urls.add(url);
    const sources = row.extra?.photo_repair_sources;
    if (Array.isArray(sources)) {
      for (const source of sources) {
        const hash = source && typeof source === "object" ? (source as { hash?: unknown }).hash : null;
        if (typeof hash === "string") hashes.add(hash);
      }
    }
  }
  return { urls, hashes };
}

async function commonsCandidates(query: string) {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "36",
    prop: "imageinfo",
    iiprop: "url|mime|size",
    iiurlwidth: "1800",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": "UudamTravelSourceTripImporter/1.0" },
  });
  if (!res.ok) return [];
  const json = await res.json() as {
    query?: {
      pages?: Record<string, { title?: string; imageinfo?: Array<{ thumburl?: string; mime?: string; size?: number }> }>;
    };
  };
  return Object.values(json.query?.pages ?? {})
    .map((page) => ({ title: page.title || query, info: page.imageinfo?.[0] }))
    .filter((item) => item.info?.thumburl && item.info.mime?.startsWith("image/") && (item.info.size ?? 0) > 80_000)
    .filter((item) => !BAD_PHOTO.test(`${item.title} ${item.info?.thumburl}`))
    .map((item) => ({ title: item.title, url: item.info!.thumburl!, mime: item.info!.mime! }));
}

async function pickPhotos(queries: string[], count = 6): Promise<Photo[]> {
  const used = await existingPhotoKeys();
  const photos: Photo[] = [];
  for (const query of queries) {
    for (const candidate of await commonsCandidates(query)) {
      if (used.urls.has(candidate.url)) continue;
      const res = await fetch(candidate.url);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength < 80_000) continue;
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (used.hashes.has(hash)) continue;
      const uploaded = await uploadImageToCloudinary(buffer, `${slug(query)}-${hash.slice(0, 10)}.jpg`, candidate.mime || "image/jpeg");
      used.urls.add(uploaded);
      used.hashes.add(hash);
      photos.push({ url: uploaded, source: candidate.url, title: candidate.title, hash, query });
      console.log(`${query} -> ${candidate.title}`);
      break;
    }
    if (photos.length >= count) break;
  }
  if (photos.length < count) throw new Error(`Only found ${photos.length}/${count} good unique photos`);
  return photos;
}

function priceTable(input: SourceTripImport) {
  const rows = [];
  if (typeof input.adultPrice === "number") rows.push({ dates: "Том хүн", cells: ["Том хүн", `${input.adultPrice.toLocaleString("mn-MN")}₮`] });
  if (typeof input.childPrice === "number") rows.push({ dates: "Хүүхэд", cells: ["Хүүхэд", `${input.childPrice.toLocaleString("mn-MN")}₮`] });
  if (typeof input.infantPrice === "number") rows.push({ dates: "Нярай", cells: ["Нярай", `${input.infantPrice.toLocaleString("mn-MN")}₮`] });
  return rows.length ? { columns: ["Ангилал", "Үнэ"], rows } : null;
}

function posterData(input: SourceTripImport, photos: Photo[]) {
  return {
    title: input.title,
    route: input.title,
    operator: input.operator || "Global Travel Corporation",
    duration: input.durationText,
    duration_text: input.durationText,
    departures: input.dates.map((date) => ({ date })),
    currency: "MNT",
    adult_price: input.adultPrice ?? null,
    child_price: input.childPrice ?? null,
    infant_price: input.infantPrice ?? null,
    hotel: input.hotel || "",
    hero_image: photos[0].url,
    price_table: priceTable(input),
    days: input.days.map((day, index) => ({
      day: index + 1,
      route: day.title,
      summary: day.description,
      photo: photos[(index + 1) % photos.length].url,
      meals: { breakfast: "Багтсан", lunch: "Багтаагүй", dinner: "Багтаагүй" },
      hotel: input.hotel || "",
    })),
    includes: input.includes || [
      "Олон улсын нислэг",
      "Хөтөлбөрийн дагуух зочид буудал",
      "Хөтөлбөрт багтсан үзвэр, аялал",
      "Аяллын зохион байгуулалт",
      "Аяллын даатгал",
    ],
    excludes: input.excludes || ["Хувийн хэрэглээний зардал", "Хөтөлбөрт дурдаагүй нэмэлт үйлчилгээ"],
    style: { photoScale: 0.82, dayTextScale: 1.12 },
    source_url: input.sourceUrl,
  };
}

export async function importSourceTrip(input: SourceTripImport) {
  const photos = await pickPhotos(input.photoQueries);
  await savePosterTrip({
    id: input.posterId,
    title: input.title,
    source_file: input.sourceUrl,
    data: posterData(input, photos),
    note: "Imported by reusable source trip importer.",
  });
  const tripId = `trip-${input.posterId}`;
  await patchTrip(tripId, {
    route_name: input.title,
    operator_name: input.operator || "Global Travel Corporation",
    duration_text: input.durationText,
    adult_price: input.adultPrice ?? null,
    child_price: input.childPrice ?? null,
    infant_price: input.infantPrice ?? null,
    currency: "MNT",
    departure_dates: input.dates,
    hotel: input.hotel || "",
    has_food: true,
    status: "active",
    photo_urls: photos.map((photo) => photo.url),
    source_description: input.sourceUrl,
    extra: {
      poster_trip_id: input.posterId,
      source_urls: [input.sourceUrl],
      original_title_text: input.title,
      brochure_pdf_required: true,
      needs_human_review: Boolean(input.reviewReasons?.length),
      review_reasons: input.reviewReasons || [],
      photo_repair_sources: photos,
      itinerary_days: input.days.map((day, index) => ({ day: index + 1, title: day.title, description: day.description })),
      included_items: input.includes || [],
      excluded_items: input.excludes || [],
    },
  });
  return { tripId, photos };
}
