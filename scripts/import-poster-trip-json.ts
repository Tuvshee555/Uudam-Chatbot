import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

type ImportFile = {
  id?: string | null;
  title?: string;
  source_file?: string | null;
  note?: string | null;
  data?: unknown;
};

function usage(): never {
  throw new Error("Usage: node --import tsx scripts/import-poster-trip-json.ts <trip.json> [--dry-run]");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  loadEnvConfig(process.cwd());
  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => !arg.startsWith("--"));
  if (!fileArg) usage();
  const dryRun = args.includes("--dry-run");
  const filePath = resolve(process.cwd(), fileArg);
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as ImportFile;
  const data = record(parsed.data);
  const title = (parsed.title || (typeof data.title === "string" ? data.title : "")).trim();
  if (!title) throw new Error("Import JSON must include title or data.title");
  if (!Object.keys(data).length) throw new Error("Import JSON must include a data object");

  const [{ savePosterTrip, linkedTripId }, { mapPosterTripToFields }, { closeNeonPool }] = await Promise.all([
    import("../src/lib/poster/db"),
    import("../src/lib/poster/tripMapper"),
    import("../src/lib/neonDb"),
  ]);

  const mapped = mapPosterTripToFields(data);
  const posterId = parsed.id?.trim() || null;
  const output = {
    mode: dryRun ? "dry-run" : "saved",
    posterId: posterId || "(auto)",
    linkedTripId: posterId ? linkedTripId(posterId) : "(auto)",
    title,
    route_name: mapped.route_name,
    duration_text: mapped.duration_text,
    departure_count: mapped.departure_dates?.length || 0,
    adult_price: mapped.adult_price ?? null,
    child_price: mapped.child_price ?? null,
    infant_price: mapped.infant_price ?? null,
    price_group_count: mapped.extra?.price_groups?.length || 0,
    day_count: Array.isArray(data.days) ? data.days.length : 0,
    photo_count: Array.isArray(data.photo_urls) ? data.photo_urls.length : 0,
  };

  if (dryRun) {
    console.log(JSON.stringify(output, null, 2));
    await closeNeonPool();
    return;
  }

  const saved = await savePosterTrip({
    id: posterId,
    title,
    source_file: parsed.source_file ?? (typeof data.source_url === "string" ? data.source_url : null),
    data,
    note: parsed.note || "Imported from JSON using scripts/import-poster-trip-json.ts",
  });
  console.log(JSON.stringify({ ...output, posterId: saved?.id ?? posterId, linkedTripId: saved?.id ? linkedTripId(saved.id) : output.linkedTripId }, null, 2));
  await closeNeonPool();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
