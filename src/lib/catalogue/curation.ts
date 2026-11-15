/**
 * Curation of the quick catalogue: which ~10 trips make the best corporate shortlist, and which
 * one belongs on the cover. PURE and deterministic (same cards -> same answer, no clock, no random).
 *
 * The shortlist is a SALES decision for company directors / HR, not "the latest edits":
 *   - a balanced mix of themes (beach / city / nature) taken from the cards' groups, never from a
 *     destination named in code; health-check trips are not a pitch for a team holiday and are
 *     only used to fill a book that would otherwise be too thin;
 *   - one destination gets at most one slot (two cards are the same destination when they share a
 *     destination key), unless a second trip is materially different: another duration band AND
 *     another transport or price tier;
 *   - premium photography first (heroQuality excellent > good > weak), a trip with a price over one
 *     that says "Үнэ лавлах", a spread of price tiers (a couple of affordable options, most in the
 *     middle, a few premium), durations and transport kinds, only trips with a bookable departure;
 *   - one photo never opens two pages;
 *   - deterministic tie-breaks (price, then title, then trip id), reasons in Mongolian per trip.
 * The cover is the strongest hero with the most inviting subject, NEVER the most recently edited trip.
 */
import { CATALOGUE_QUICK_MAX_TRIPS, CATALOGUE_QUICK_MIN_TRIPS, type CataloguePhotoQuality, type CatalogueTripCard } from "./types";
import { GROUP_DEFS } from "./groups";
import { photoKey } from "./photos";

export const DEFAULT_SHORTLIST_SIZE = 10;

export type Shortlist = { tripIds: string[]; reasons: Record<string, string>; cover: string | null };

type Tier = "low" | "mid" | "high" | "?";
type Pool = { card: CatalogueTripCard; tier: Tier; base: number };

const QUALITY_POINTS: Record<CataloguePhotoQuality, number> = { excellent: 34, good: 20, weak: 0, missing: -40 };
/** How inviting a theme is on a cover or in a pitch to a team. */
const APPEAL_POINTS: Record<string, number> = { beach: 10, nature: 8, city: 7, wellness: -12, budget: 4, other: -6 };
/**
 * Share of the shortlist each theme should hold. Health-check trips (wellness) are not a pitch for a
 * team holiday and "other" is unclassified: neither gets a reserved slot.
 */
const THEME_SHARE: Array<[string, number]> = [["beach", 0.35], ["city", 0.3], ["nature", 0.2], ["budget", 0.1]];
/** Share of the shortlist per price tier: a couple of affordable options, most in the middle, a few premium. */
const TIER_SHARE: Record<Tier, number> = { low: 0.2, mid: 0.4, high: 0.4, "?": 0 };

const groupLabel = (key: string) => GROUP_DEFS.find((def) => def.key === key)?.label ?? "Бусад";

function priceOf(card: CatalogueTripCard): number | null {
  return card.price.kind === "from" ? card.price.amountMnt : null;
}

/** Days of the trip from its duration text ("9 өдөр 8 шөнө", "5 шөнө / 6 өдөр", "8 өдөр"); null when unreadable. */
export function tripDays(card: Pick<CatalogueTripCard, "durationText">): number | null {
  const text = card.durationText || "";
  const days = /(\d{1,2})\s*өдөр/iu.exec(text);
  if (days) return Number(days[1]);
  const nights = /(\d{1,2})\s*шөнө/iu.exec(text);
  return nights ? Number(nights[1]) + 1 : null;
}

const durationBand = (card: CatalogueTripCard): string => {
  const days = tripDays(card);
  return days === null ? "?" : days <= 6 ? "short" : days <= 8 ? "mid" : "long";
};

/** Price terciles over the bookable priced cards. */
function tierFinder(cards: readonly CatalogueTripCard[]): (card: CatalogueTripCard) => Tier {
  const prices = cards.map(priceOf).filter((n): n is number => n !== null).sort((a, b) => a - b);
  if (prices.length < 3) return (card) => (priceOf(card) === null ? "?" : "mid");
  const lowCut = prices[Math.floor(prices.length / 3)]!;
  const highCut = prices[Math.floor((prices.length * 2) / 3)]!;
  return (card) => {
    const p = priceOf(card);
    return p === null ? "?" : p < lowCut ? "low" : p >= highCut ? "high" : "mid";
  };
}

const bookable = (card: CatalogueTripCard) =>
  card.dates.nextDeparture !== null || card.dates.departures.length > 0 || (card.dates.label.length > 0 && !/лавлана/iu.test(card.dates.label));

const keysOf = (card: CatalogueTripCard): string[] => (card.destinationKeys?.length ? card.destinationKeys : card.destinationKey ? [card.destinationKey] : []);
const sameDestination = (a: CatalogueTripCard, b: CatalogueTripCard): boolean => {
  const other = new Set(keysOf(b));
  return keysOf(a).some((key) => other.has(key));
};

/** Hero + subject strength of one card. */
function appealOf(card: CatalogueTripCard): number {
  const width = card.photo?.width ?? null;
  const resolutionBonus = width === null ? 0 : width >= 1800 ? 4 : width >= 1400 ? 2 : 0;
  const flight = /нислэг/iu.test(card.transportLabel) ? 3 : 0;
  return QUALITY_POINTS[card.heroQuality] + (APPEAL_POINTS[card.groupKey] ?? 0) + resolutionBonus + flight + (card.price.kind === "from" ? 2 : -25);
}

const tie = (a: CatalogueTripCard, b: CatalogueTripCard) =>
  (priceOf(a) ?? Infinity) - (priceOf(b) ?? Infinity) || a.title.localeCompare(b.title) || a.tripId.localeCompare(b.tripId);

/** The most inviting cover: best hero, then subject, deterministic. Never the newest trip. */
export function pickCoverTrip(cards: readonly CatalogueTripCard[]): string | null {
  const pool = cards.filter((card) => card.heroQuality !== "missing" && card.photo);
  if (!pool.length) return null;
  // Ties go to the sharper, larger photo, never to the cheaper or the newer trip.
  const widthOf = (card: CatalogueTripCard) => card.photo?.width ?? 0;
  const ranked = [...pool].sort((a, b) => appealOf(b) - appealOf(a) || widthOf(b) - widthOf(a) || a.title.localeCompare(b.title) || a.tripId.localeCompare(b.tripId));
  return ranked[0]!.tripId;
}

/**
 * The recommended quick shortlist (default 10, within CATALOGUE_QUICK_MIN/MAX), cover first.
 * Greedy and deterministic: each round takes the card with the best marginal value given what is
 * already chosen (theme still short of its share, price tier, duration band, transport, a photo not
 * yet used). Cards of the same destination are skipped unless materially different.
 */
export function recommendShortlist(cards: readonly CatalogueTripCard[], opts: { size?: number } = {}): Shortlist {
  const size = Math.max(CATALOGUE_QUICK_MIN_TRIPS, Math.min(CATALOGUE_QUICK_MAX_TRIPS, Math.round(opts.size ?? DEFAULT_SHORTLIST_SIZE)));
  // A premium shortlist shows a real starting price: trips that can only say "Үнэ лавлах" are held back
  // unless there are too few priced ones to fill a book.
  // A trip whose hero is weak or missing is never recommended while enough trips with a real photograph remain
  // (a thin photo opening a page spoils a premium book). Price is the softer preference.
  const photoReady = (card: CatalogueTripCard) => card.heroQuality === "excellent" || card.heroQuality === "good";
  const withPrice = (list: readonly CatalogueTripCard[]) => list.filter((card) => card.price.kind === "from");
  const open = cards.filter(bookable);
  const ready = open.filter(photoReady);
  const sellable = withPrice(ready).length >= CATALOGUE_QUICK_MIN_TRIPS ? withPrice(ready)
    : ready.length >= CATALOGUE_QUICK_MIN_TRIPS ? ready
      : withPrice(open).length >= CATALOGUE_QUICK_MIN_TRIPS ? withPrice(open) : open;
  const tierOf = tierFinder(sellable);
  const toPool = (card: CatalogueTripCard): Pool => ({ card, tier: tierOf(card), base: appealOf(card) });
  const byBase = (a: Pool, b: Pool) => b.base - a.base || tie(a.card, b.card);
  // Health-check trips are held back: they only fill a book that would otherwise be thin.
  const pool = sellable.filter((card) => card.groupKey !== "wellness").map(toPool).sort(byBase);
  const reserve = sellable.filter((card) => card.groupKey === "wellness").map(toPool).sort(byBase);
  const chosen: Pool[] = [];
  const reasons: Record<string, string> = {};

  const themeTarget = (groupKey: string) => {
    const share = THEME_SHARE.find(([key]) => key === groupKey)?.[1] ?? 0;
    return share === 0 ? 0 : Math.max(1, Math.round(size * share));
  };
  const tierTarget = (tier: Tier) => Math.max(tier === "?" ? 0 : 1, Math.round(size * TIER_SHARE[tier]));
  const count = <T,>(pick: (p: Pool) => T, value: T) => chosen.filter((p) => pick(p) === value).length;
  const heroKeyOf = (p: Pool) => (p.card.photo ? photoKey(p.card.photo.url) : null);

  const marginal = (p: Pool): number => {
    let value = p.base;
    const heroKey = heroKeyOf(p);
    if (heroKey && chosen.some((c) => heroKeyOf(c) === heroKey)) value -= 40; // one photo never opens two pages
    const haveGroup = count((c) => c.card.groupKey, p.card.groupKey);
    value += haveGroup < themeTarget(p.card.groupKey) ? 12 : -14 * (haveGroup - themeTarget(p.card.groupKey) + 1);
    const haveTier = count((c) => c.tier, p.tier);
    value += haveTier < tierTarget(p.tier) ? 6 : -5 * (haveTier - tierTarget(p.tier) + 1);
    const band = durationBand(p.card);
    value += count((c) => durationBand(c.card), band) === 0 ? 4 : -2 * count((c) => durationBand(c.card), band);
    if (p.card.transportLabel) {
      const haveTransport = count((c) => c.card.transportLabel, p.card.transportLabel);
      value += haveTransport === 0 ? 3 : -1 * haveTransport;
    }
    return value;
  };

  /** A second trip to a destination already on the list must differ materially (duration band AND transport or price tier). */
  const allowed = (p: Pool): boolean =>
    chosen.filter((other) => sameDestination(other.card, p.card)).every((other) =>
      durationBand(other.card) !== durationBand(p.card) && (other.card.transportLabel !== p.card.transportLabel || other.tier !== p.tier));

  const describe = (p: Pool): string =>
    [groupLabel(p.card.groupKey), p.card.durationText || null, p.card.price.display, p.card.transportLabel || null].filter(Boolean).join(" · ");
  const take = (p: Pool, why: string) => {
    chosen.push(p);
    reasons[p.card.tripId] = why;
  };

  const cover = pickCoverTrip(pool.map((p) => p.card));
  const coverPool = pool.find((p) => p.card.tripId === cover);
  if (coverPool) take(coverPool, `Нүүр хуудас: хамгийн сайн зураг, урих сэдэв — ${describe(coverPool)}`);

  while (chosen.length < size) {
    const open = pool.filter((p) => !chosen.includes(p) && allowed(p));
    if (!open.length) break;
    const best = [...open].sort((a, b) => marginal(b) - marginal(a) || byBase(a, b))[0]!;
    const fillsTheme = count((c) => c.card.groupKey, best.card.groupKey) < themeTarget(best.card.groupKey);
    const why = best.tier === "low" && count((c) => c.tier, "low") < tierTarget("low")
      ? `Хэмнэлттэй сонголт — ${describe(best)}`
      : fillsTheme
        ? `${groupLabel(best.card.groupKey)} чиглэлийн сонголт — ${describe(best)}`
        : `Нэмэлт өөр сонголт (үнэ/хугацаа/тээвэр өөр) — ${describe(best)}`;
    take(best, why);
  }

  // Not enough distinct destinations: fill with what is left rather than print a thin book.
  if (chosen.length < CATALOGUE_QUICK_MIN_TRIPS) {
    const rest = [...pool.filter((p) => !chosen.includes(p)), ...reserve].sort((a, b) => marginal(b) - marginal(a) || byBase(a, b));
    for (const p of rest) {
      if (chosen.length >= CATALOGUE_QUICK_MIN_TRIPS) break;
      take(p, `Нөхөн сонголт — ${describe(p)}`);
    }
  }
  return {
    tripIds: chosen.map((p) => p.card.tripId),
    reasons,
    cover: cover && chosen.some((p) => p.card.tripId === cover) ? cover : (chosen[0]?.card.tripId ?? null),
  };
}
