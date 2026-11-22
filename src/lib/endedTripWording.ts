/**
 * The words the bot uses for a trip whose dates have ended (endedTrip.ts). No imports: the program fast path and
 * the catalogue listing read them too.
 *
 * Short on purpose (owner, 2026-11-22: "the bot sends too much"): staff answer in one line, median 34 characters,
 * over 1,118 of their messages in 45 days; the bot's median was 147. The owner's own word is «дууссан».
 */

/** Part of every ended-trip reply; later turns recognise the reply by it. */
export const ENDED_TRIP_MARKER = "аялал дууссан";

/** The same for a trip that never had a date. */
export const NEVER_DATED_LINE = "гарах өдөр одоогоор товлогдоогүй";

/** The "this trip is full; these are open" reply's list heading (travelFastPaths.ts); later turns pick from that list. */
export const OPEN_ALTERNATIVES_HEADING = "Гэхдээ ижил чиглэлд эдгээр аялал нээлттэй байна:";

/**
 * Owner, 2026-11-22: an ended trip can still go for a group of ten or more (a company, an organisation) on a date
 * they choose.
 */
export const ENDED_TRIP_GROUP_LINE = "10+ хүнтэй байгууллага, групп бол өөрсдийн сонгосон өдрөөр явж болно.";
