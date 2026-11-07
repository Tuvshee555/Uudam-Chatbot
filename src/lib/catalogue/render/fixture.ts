/**
 * Invented, clearly synthetic fixtures for the renderer's tests and the visual sample script.
 * Trips are made up ("Тест-Далай", ...), photos are generated gradients with grain, and nothing here
 * names a real trip, place, price or date.
 */
import sharp from "sharp";
import type { CatalogueGroup, CatalogueSnapshot, CatalogueTripCard } from "../types";

type Palette = { sky1: string; sky2: string; far: string; mid: string; near: string; water?: string; sun: string };

const PALETTES: Palette[] = [
  { sky1: "#6FB3D8", sky2: "#E9D8B8", far: "#6C8F7A", mid: "#3F7A5C", near: "#25513D", water: "#2C86A8", sun: "#FFF1C2" },
  { sky1: "#8FB6D6", sky2: "#F2E4C8", far: "#8D9A6A", mid: "#6E8B47", near: "#4B6A30", sun: "#FFF4D0" },
  { sky1: "#D9A47A", sky2: "#F6D8A8", far: "#A06A52", mid: "#7B4C3C", near: "#4E2F29", sun: "#FFE7B0" },
  { sky1: "#7FA4C4", sky2: "#DCE6EA", far: "#8E9AA6", mid: "#66727F", near: "#3E4852", water: "#5B8BA6", sun: "#F8F6EC" },
];

/** Synthetic landscape. `seed` varies hill shapes; width/height are the output pixels. */
export async function makeSyntheticPhoto(seed: number, width = 2000, height = 1500): Promise<Buffer> {
  const p = PALETTES[seed % PALETTES.length]!;
  const rnd = (n: number) => {
    const x = Math.sin((seed + 1) * 9301 + n * 49297) * 233280;
    return x - Math.floor(x);
  };
  const horizon = height * (0.5 + rnd(1) * 0.12);
  const hill = (base: number, amp: number, k: number) => {
    const pts: string[] = [`0,${height}`];
    for (let i = 0; i <= 24; i++) {
      const x = (width / 24) * i;
      const y = base - Math.abs(Math.sin(i * 0.55 + k + rnd(k + i) * 2)) * amp - rnd(i + k * 3) * amp * 0.25;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    pts.push(`${width},${height}`);
    return `<polygon points="${pts.join(" ")}"/>`;
  };
  const sunX = width * (0.25 + rnd(7) * 0.5);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky1}"/><stop offset="1" stop-color="${p.sky2}"/></linearGradient>
    <radialGradient id="sun"><stop offset="0" stop-color="${p.sun}" stop-opacity="0.95"/><stop offset="1" stop-color="${p.sun}" stop-opacity="0"/></radialGradient>
    <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.water ?? p.mid}"/><stop offset="1" stop-color="${p.near}"/></linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="${sunX}" cy="${horizon * 0.62}" r="${width * 0.16}" fill="url(#sun)"/>
  ${p.water ? `<rect x="0" y="${horizon}" width="${width}" height="${height - horizon}" fill="url(#water)"/>` : ""}
  <g fill="${p.far}">${hill(horizon + 40, height * 0.16, 1)}</g>
  <g fill="${p.mid}">${hill(horizon + height * 0.16, height * 0.14, 5)}</g>
  <g fill="${p.near}">${hill(height * 0.98, height * 0.2, 9)}</g>
</svg>`;
  // Film-like grain from one small random tile, repeated; cheap and obviously synthetic.
  const tile = Math.min(128, width, height);
  const grain = Buffer.alloc(tile * tile * 3);
  for (let i = 0; i < grain.length; i++) grain[i] = 118 + Math.floor(Math.random() * 20);
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(base)
    .composite([{ input: grain, raw: { width: tile, height: tile, channels: 3 }, tile: true, blend: "soft-light" }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

type Spec = {
  title: string;
  kicker: string;
  groupKey: string;
  duration: string;
  transport: string;
  highlights: string[];
  price: number | null;
  date: string | null;
  photo: "ok" | "none" | "fail" | "small";
};

export const SAMPLE_GROUPS: { key: string; label: string }[] = [
  { key: "sea", label: "Далайн амралт" },
  { key: "nature", label: "Байгаль, адал явдал" },
  { key: "budget", label: "Хямд төсвийн аялал" },
];

const SPECS: Spec[] = [
  { title: "Тест-Далай", kicker: "Жишиг муж / Тест улс", groupKey: "sea", duration: "9 өдөр · 8 шөнө", transport: "Шууд нислэг", highlights: ["Жишиг-Эргийн зочид буудалд байрлана", "Тест-Далайн эрэг дээрх чөлөөт өдрүүд", "Загвар-Парк болон орон нутгийн зах"], price: 3740000, date: "2027-02-13", photo: "ok" },
  { title: "Жишиг-Хөдөө Нутгийн Өвөл", kicker: "Өвөр Жишиг / Тест улс", groupKey: "nature", duration: "5 өдөр · 4 шөнө", transport: "Газрын аялал", highlights: ["Тест-Гүүрэн дээрх алхалт", "Халуун рашаан, усан амралтын цогцолбор", "Хөх хотын аялал, шинжилгээ"], price: 870000, date: "2026-12-19", photo: "ok" },
  { title: "Загвар-Хот ба Туршилтын Нуурын эргийн урт нэртэй есөн өдрийн ихэр аялал", kicker: "Хоёр хот / Жишиг улс", groupKey: "nature", duration: "9 өдөр · 8 шөнө", transport: "Галт тэрэг", highlights: ["Нэг маш урт онцлог мөр нь хоёр, гурван мөр болтлоо үргэлжилж болох бөгөөд хуудас хэзээ ч таслагдахгүй байх ёстой", "Богино онцлог", "Ө, Ү, ө, ү үсэг бүхий мөр ба ₮ тэмдэгт"], price: 2450000, date: "2027-03-20", photo: "ok" },
  { title: "Туршилт-Арал", kicker: "Тест арал", groupKey: "sea", duration: "6 өдөр · 5 шөнө", transport: "Шууд нислэг", highlights: ["Усан доорх жишиг аялал"], price: 4620000, date: "2027-02-06", photo: "small" },
  { title: "Хөдөө-Хуурай", kicker: "Хуурай муж", groupKey: "budget", duration: "4 өдөр · 3 шөнө", transport: "Газрын аялал", highlights: ["Зураг байхгүй тохиолдлын туршилт", "Хоёр дахь онцлог"], price: 690000, date: null, photo: "none" },
  { title: "Зураг-Алдаа", kicker: "Алдаа муж", groupKey: "budget", duration: "3 өдөр · 2 шөнө", transport: "Газрын аялал", highlights: ["Зураг татагдахгүй тохиолдол"], price: null, date: null, photo: "fail" },
];

export type SampleOptions = { trips?: number; edition?: CatalogueSnapshot["edition"] };

export function sampleSnapshot(opts: SampleOptions = {}): CatalogueSnapshot {
  const count = opts.trips ?? SPECS.length;
  const trips: CatalogueTripCard[] = [];
  for (let i = 0; i < count; i++) {
    const s = SPECS[i % SPECS.length]!;
    const n = i + 1;
    const code = `${i < 99 ? "A" : "B"}${String((i % 99) + 1).padStart(2, "0")}`;
    const priced = s.price !== null;
    trips.push({
      tripId: `fx-trip-${n}`,
      code,
      title: i < SPECS.length ? s.title : `${s.title} ${n}`,
      kicker: s.kicker,
      groupKey: s.groupKey,
      durationText: s.duration,
      transportLabel: s.transport,
      highlights: s.highlights,
      price: priced
        ? { kind: "from", amountMnt: s.price!, date: s.date, display: `${s.price!.toLocaleString("en-US")}₮-с` }
        : { kind: "inquire", display: "Үнэ лавлах" },
      dates: s.date
        ? { nextDeparture: s.date, departures: [s.date], label: `${s.date.replace(/-/g, ".")}-ний хөдлөлт` }
        : { nextDeparture: null, departures: [], label: "Явах огноог лавлана" },
      detailUrl: `https://example.test/trips/fx-trip-${n}`,
      photo: s.photo === "none" ? null : { url: `https://photos.example.test/${s.photo}/${n}.jpg`, width: null, height: null, credit: n % 2 === 0 ? "Жишиг зураг" : null, source: "poster_hero" },
      warnings: [],
    });
  }
  const groups: CatalogueGroup[] = SAMPLE_GROUPS.map(g => ({ key: g.key, label: g.label, codes: trips.filter(t => t.groupKey === g.key).map(t => t.code) })).filter(g => g.codes.length > 0);
  return {
    edition: opts.edition ?? "preview",
    generatedAt: "2026-11-06T06:03:00.000Z",
    asOfDay: "2026-11-06",
    issueLabel: "2026.11.06",
    seasonLabel: "2026 / 2027",
    trips,
    groups,
    contact: { phones: ["7700 0001", "9900 0002"], siteLabel: "example.test", siteUrl: "https://example.test" },
    warnings: [],
    contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

/** Fetcher that serves the synthetic photos by URL shape: /ok/, /small/ resolve, /fail/ does not. */
export function sampleImageFetcher(): (url: string) => Promise<Buffer | null> {
  const cache = new Map<string, Promise<Buffer | null>>();
  return url => {
    let hit = cache.get(url);
    if (!hit) {
      const m = /\/(ok|small|fail)\/(\d+)\.jpg$/.exec(url);
      if (!m || m[1] === "fail") hit = Promise.resolve(null);
      else hit = makeSyntheticPhoto(Number(m[2]), m[1] === "small" ? 640 : 2000, m[1] === "small" ? 480 : 1500);
      cache.set(url, hit);
    }
    return hit;
  };
}
