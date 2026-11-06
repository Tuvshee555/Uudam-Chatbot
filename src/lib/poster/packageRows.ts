/**
 * A poster's price table has one "Буудал" column. A trip sold as hotel × package (the partner
 * sync's 2 hotels × 2 packages) shows it there as "Hotel · Package", which reads well on the
 * poster. Mapped back as-is, a poster save turned every row into a fifth "hotel" that the
 * resolver, the bot and the website could not pick a package from, until the next partner sync
 * split it again. This splits it back against the trip's own package list and keeps the row facts
 * the poster does not hold (seats, sold-out state, linked hotel profiles).
 */
import { linkHotelOptions, type HotelOptionLink, type HotelProfileInput } from "@/lib/partnerSync/hotelProfiles";

type Row = Record<string, unknown>;

const PACKAGE_SEPARATOR = " · ";
/** Row facts that live only on the trip; a poster row never carries them. */
const TRIP_ONLY_ROW_KEYS = ["status", "seats_left", "partner_source"] as const;

const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const sameKey = (a: string, b: string) => a.normalize("NFKC").toLocaleLowerCase() === b.normalize("NFKC").toLocaleLowerCase();
const dateList = (value: unknown) => (Array.isArray(value) ? value.map(String).sort().join(",") : "");

type PackageOption = { id: string; label: string };

function packageOptions(extra: Row): PackageOption[] {
  return records(extra.package_options)
    .map((option) => ({ id: text(option.id) || text(option.label), label: text(option.label) || text(option.id) }))
    .filter((option) => option.id);
}

/** "Norvel · Хөтөлбөртэй" → hotel "Norvel", package "Хөтөлбөртэй", only when that package is one of the trip's. */
export function splitPackagedHotel(hotel: string, packages: PackageOption[]): { hotel: string; packageId: string } | null {
  const at = hotel.lastIndexOf(PACKAGE_SEPARATOR);
  if (at <= 0) return null;
  const right = hotel.slice(at + PACKAGE_SEPARATOR.length).trim();
  const match = packages.find((option) => sameKey(option.label, right) || sameKey(option.id, right));
  const left = hotel.slice(0, at).trim();
  return match && left ? { hotel: left, packageId: match.id } : null;
}

export function splitPackagedHotelRows<T extends Row>(groups: T[], existingExtra: unknown): T[] {
  const extra = record(existingExtra);
  const packages = packageOptions(extra);
  if (!packages.length) return groups;
  const profiles = records(extra.hotel_profiles) as HotelProfileInput[];
  const previous = records(extra.price_groups);
  const splits = groups.map((group) => (text(group.package_id) ? null : splitPackagedHotel(text(group.hotel), packages)));
  // The partner sync's own linker: two different options on one date that read as the same
  // hotel keep apart (no shared hotel_id) instead of turning into a fare conflict.
  const links = profiles.length
    ? linkHotelOptions(groups.map((group, index) => ({ hotel: splits[index]?.hotel ?? text(group.hotel), dates: Array.isArray(group.dates) ? group.dates.map(String) : [] })), profiles)
    : new Map<string, HotelOptionLink>();
  return groups.map((group, index) => {
    const split = splits[index];
    if (!split) return group;
    const link = links.get(split.hotel) ?? { hotelId: null, profileIds: [] };
    const before = previous.find((row) => text(row.hotel) === split.hotel && text(row.package_id) === split.packageId && dateList(row.dates) === dateList(group.dates));
    const kept = before ? Object.fromEntries(TRIP_ONLY_ROW_KEYS.filter((key) => key in before).map((key) => [key, before[key]])) : {};
    return {
      ...group,
      hotel: split.hotel,
      package_id: split.packageId,
      ...(link.hotelId ? { hotel_id: link.hotelId } : {}),
      ...(link.profileIds.length ? { hotel_profile_ids: link.profileIds } : {}),
      ...kept,
    };
  });
}
