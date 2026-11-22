/**
 * The words the bot uses for a trip whose dates have ended (endedTrip.ts). No imports: the program fast path and
 * the catalogue listing read them too.
 */

/** Part of every ended-trip reply; later turns recognise the reply by it. */
export const ENDED_TRIP_MARKER = "аяллын товлосон гарах өдрүүд дууссан";

/** The "this trip is full; these are open" reply's list heading (travelFastPaths.ts); later turns pick from that list. */
export const OPEN_ALTERNATIVES_HEADING = "Гэхдээ ижил чиглэлд эдгээр аялал нээлттэй байна:";

/** The same for a trip that never had a date. */
export const NEVER_DATED_LINE = "Энэ аяллын гарах өдөр одоогоор товлогдоогүй байна.";

/**
 * Owner, 2026-11-22: an ended trip can still go for a group of ten or more (a company, an organisation) on a date
 * they choose.
 */
export const ENDED_TRIP_GROUP_LINE = "👥 10 ба түүнээс дээш хүнтэй байгууллага, компани, хамт олон бол энэ аяллаар өөрсдийн сонгосон өдөр явах боломжтой.";
