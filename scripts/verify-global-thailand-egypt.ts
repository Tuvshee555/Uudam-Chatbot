import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { getPosterPdfPublicUrl } from "../src/lib/poster/pdfUrl";

const expected = [
  {
    id: "trip-poster-global-bangkok-pattaya-2026-11-18",
    title: "БАНГКОК - ПАТТАЯА АЯЛАЛ",
    duration: "8 өдөр 7 шөнө",
    dates: ["2026-11-18"],
    adult: 4_390_000,
    child: null,
  },
  {
    id: "trip-poster-global-egypt-direct-flight-2026-12-05",
    title: "ЕГИПЕТ шууд нислэгтэй аялал",
    duration: "7 өдөр 6 шөнө",
    dates: ["2026-12-05"],
    adult: null,
    child: null,
  },
];

async function main() {
  const rows = await queryNeon<{
    id: string;
    route_name: string;
    duration_text: string;
    adult_price: number | null;
    child_price: number | null;
    departure_dates: string[];
    photo_urls: string[];
    extra: Record<string, unknown> | null;
  }>(
    `SELECT id, route_name, duration_text, adult_price, child_price, departure_dates, photo_urls, extra
       FROM travel_trip_entries
      WHERE id = ANY($1)`,
    [expected.map((item) => item.id)],
  );
  const byId = new Map((rows?.rows ?? []).map((row) => [row.id, row]));
  const errors: string[] = [];
  const seenPhotos = new Set<string>();

  for (const item of expected) {
    const row = byId.get(item.id);
    if (!row) {
      errors.push(`${item.id} missing`);
      continue;
    }
    const posterId = String(row.extra?.poster_trip_id ?? "");
    const pdf = getPosterPdfPublicUrl(posterId);
    console.log(`${row.route_name}: dates=${row.departure_dates.join(", ")} price=${row.adult_price}/${row.child_price} photos=${row.photo_urls.length} pdf=${pdf}`);
    if (row.route_name !== item.title) errors.push(`${item.id} wrong title`);
    if (row.duration_text !== item.duration) errors.push(`${item.id} wrong duration`);
    if (row.adult_price !== item.adult) errors.push(`${item.id} wrong adult price`);
    if (row.child_price !== item.child) errors.push(`${item.id} wrong child price`);
    for (const date of item.dates) if (!row.departure_dates.includes(date)) errors.push(`${item.id} missing date ${date}`);
    if (row.photo_urls.length < 6) errors.push(`${item.id} expected at least 6 photos`);
    for (const url of row.photo_urls) {
      if (!url.startsWith("https://res.cloudinary.com/")) errors.push(`${item.id} has non-Cloudinary photo`);
      if (seenPhotos.has(url)) errors.push(`${item.id} duplicate photo ${url}`);
      seenPhotos.add(url);
    }
    if (!pdf) errors.push(`${item.id} missing PDF URL`);
  }

  if (errors.length) throw new Error(errors.join("; "));
}

main()
  .finally(() => closeNeonPool())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
