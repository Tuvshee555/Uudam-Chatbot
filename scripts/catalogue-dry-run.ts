/**
 * Dry run of the corporate catalogue, end to end, against the LIVE trips. Nothing is stored and
 * nothing is sent.
 *
 *   npm run catalogue:dry-run -- [--edition quick|complete] [--count 10] [--trips id1,id2]
 *                                [--out <folder>] [--no-photos]
 *   (= node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/catalogue-dry-run.ts ...)
 *
 * What is real: the live trips and poster photos (SELECT statements only), the snapshot builder,
 * the PDF renderer (headless Chromium, real photos unless --no-photos), the freshness check and the
 * delivery code that decides what a customer receives.
 * What is not: Neon is never written (the store is in memory, trip codes are READ from the
 * database when it has them and provisional otherwise), Meta is never called (upload and send are
 * stubs that record the calls) and no model is used.
 *
 * It prints, in order, exactly what a customer who asks for the catalogue would receive: the
 * upload, the ONE caption text and the ONE file attachment, with file name, size, page count and
 * version label, then the freshness verdict, the trips with their codes and the warnings staff
 * would see before publishing. --out also writes the PDF and report.json to that folder.
 *
 * Use it before the first real send (docs/corporate-catalogue.md, "Before the first real send").
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fakeSendStore } from "../tests/helpers/catalogueSendFakes";
import type { CatalogueEdition, CatalogueSnapshot, CatalogueVersionMeta, CatalogueWarning } from "../src/lib/catalogue/types";
import type { TravelTrip } from "../src/lib/travelTypes";

// Read-only end to end. A warn/error log from an app module is otherwise copied into
// travel_error_logs over its own pool (observability.ts). The flags are read when observability
// loads, so every app module is imported inside main(), after these lines. Forced, whatever .env says.
process.env.ERROR_LOG_DB_ENABLED = "false";
// Belt and braces: even a stray real Meta call would be suppressed.
process.env.WEBHOOK_BOT_DISABLED = "1";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null;
};
const has = (name: string) => args.includes(name);

const edition: CatalogueEdition = flag("--edition") === "complete" ? "complete" : "quick";
const count = Math.max(1, Math.min(12, Number(flag("--count") || 10) || 10));
const tripIdsArg = (flag("--trips") || "").split(",").map((id) => id.trim()).filter(Boolean);
const outDir = flag("--out") ? path.resolve(flag("--out")!) : null;
const noPhotos = has("--no-photos");

const DRY_RECIPIENT = "DRY-RUN-PSID";
const DRY_PAGE = "DRY-RUN-PAGE";
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;

async function main() {
  const [{ queryNeon }, { mapTripRow }, { contactSettingsOf }, { BOOKING_WEBSITE_URL }, data, contact, codes, versions, render, send, fresh, fb, messenger, types] = await Promise.all([
    import("../src/lib/neonDb"),
    import("../src/lib/travelDb"),
    import("../src/lib/contactReplies"),
    import("../src/lib/bookingWebsite"),
    import("../src/lib/catalogue/tripData"),
    import("../src/lib/catalogue/contact"),
    import("../src/lib/catalogue/codes"),
    import("../src/lib/catalogue/versions"),
    import("../src/lib/catalogue/render"),
    import("../src/lib/catalogue/send"),
    import("../src/lib/catalogue/freshness"),
    import("../src/lib/fbAttachmentUpload"),
    import("../src/lib/messenger"),
    import("../src/lib/catalogue/types"),
  ]);

  // ── 1. Live data, read only ────────────────────────────────────────────────────────────────
  const readTrips = async (): Promise<TravelTrip[]> => {
    const result = await queryNeon<Record<string, unknown>>("SELECT * FROM travel_trip_entries WHERE status = 'active'");
    if (!result) throw new Error("NEON_DATABASE_URL is not configured (.env.local): the dry run needs the live trips to read.");
    return result.rows.map(mapTripRow);
  };
  const trips = await readTrips();
  const settings = await queryNeon<{ extra: unknown }>("SELECT extra FROM travel_bot_settings LIMIT 1");
  const phones = contact.parsePhones(contactSettingsOf(settings?.rows[0]?.extra).phones);

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const emptyConfig = { tripIds: [] as string[], groupOverrides: {}, featuredTripIds: [] as string[], excludedTripIds: [] as string[] };
  const eligible = data.planEdition({ edition: "complete", trips, config: emptyConfig }, today).trips;
  const picked = tripIdsArg.length
    ? tripIdsArg
    : edition === "complete" ? eligible.map((trip) => trip.id) : [...eligible].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, count).map((trip) => trip.id);
  const config = { ...emptyConfig, tripIds: picked };
  const planned = data.planEdition({ edition, trips, config }, today).trips;

  // Codes: the stored ones when the table exists, provisional ones after them otherwise. Never written.
  const stored: Record<string, string> = {};
  try {
    const result = await queryNeon<{ trip_id: string; code: string }>("SELECT trip_id, code FROM catalogue_codes ORDER BY seq ASC");
    for (const row of result?.rows ?? []) stored[row.trip_id] = row.code;
  } catch { /* the catalogue tables do not exist yet: every code below is provisional */ }
  let nextSeq = Math.max(0, ...Object.values(stored).map((code) => codes.seqForCode(code) ?? 0)) + 1;
  const codeMap: Record<string, string> = {};
  const provisional = new Set<string>();
  for (const trip of [...planned].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    if (stored[trip.id]) { codeMap[trip.id] = stored[trip.id]; continue; }
    codeMap[trip.id] = codes.codeForSeq(nextSeq++);
    provisional.add(trip.id);
  }
  const posterByTripId = await data.loadPosterRows(planned);

  const buildSnapshot = (at: string, liveTrips: TravelTrip[], posters: Record<string, unknown>): CatalogueSnapshot =>
    data.buildCatalogueSnapshot({
      edition, nowIso: at, trips: liveTrips, posterByTripId: posters, config, codeMap, contactPhones: phones,
      siteBaseUrl: BOOKING_WEBSITE_URL,
    });
  const snapshot = buildSnapshot(nowIso, trips, posterByTripId);

  // ── 2. Render (real) ───────────────────────────────────────────────────────────────────────
  if (!(await render.isRenderBrowserAvailable())) {
    throw new Error("No headless Chromium here (set CHROME_EXECUTABLE_PATH or install Chrome): the PDF cannot be rendered.");
  }
  const started = Date.now();
  const versionNo = 1;
  const fileName = versions.buildVersionFileName(edition, snapshot.asOfDay, versionNo);
  const versionLabel = `${edition} dry-run v${versionNo}`;
  const rendered = await render.renderCatalogue(snapshot, {
    pageImages: false, versionLabel, ...(noPhotos ? { imageFetcher: async () => null } : {}),
  });
  const warnings: CatalogueWarning[] = [...snapshot.warnings, ...rendered.warnings];

  // ── 3. An in-memory "published" version and a stubbed Meta ────────────────────────────────
  const version: CatalogueVersionMeta = {
    id: randomUUID(), edition, versionNo, fileName, status: "published", sizeBytes: rendered.pdf.length, pageCount: rendered.pageCount,
    sha256: createHash("sha256").update(rendered.pdf).digest("hex"), contentHash: snapshot.contentHash, tripCount: snapshot.trips.length,
    generatedAt: nowIso, generatedBy: "dry-run", publishedAt: nowIso, publishedBy: "dry-run", publicToken: "dry-run-token", warnings,
  };
  const fake = fakeSendStore(() => Date.now());
  fake.publish(version, rendered.pdf);

  type Step = { n: number; request: string; detail: string; body?: unknown };
  const steps: Step[] = [];
  const add = (request: string, detail: string, body?: unknown) => steps.push({ n: steps.length + 1, request, detail, body });
  const publicUrl = `${snapshot.contact.siteUrl}${types.CATALOGUE_PUBLIC_FILE_PATH}/${version.publicToken}`;
  const leads: Array<{ status: string; reason: string; context: string }> = [];

  // Freshness: what a customer's request would be judged against (a second read of the live trips).
  const liveNow = await readTrips();
  const drift = data.liveDrift(snapshot, buildSnapshot(new Date().toISOString(), liveNow, posterByTripId));
  const verdict = fresh.evaluateFreshness({ published: version, nowIso: new Date().toISOString(), drift });

  const outcome = await send.deliverCatalogue({
    senderId: DRY_RECIPIENT, pageId: DRY_PAGE, pageToken: "DRY-RUN-TOKEN", edition, explicitResend: false,
    lastInboundAt: Date.now(), dedupeKey: "dry-run-1", customerText: "(dry run) каталог явуулаач",
    captureLead: async (lead) => { leads.push(lead); },
    deps: {
      store: fake.store,
      gate: async () => null,
      killSwitch: () => false,
      checkDrift: async () => drift,
      upload: async (bytes, name) => {
        add("POST /me/message_attachments", `filedata=${name} (${bytes.length} bytes, application/pdf), message={"attachment":{"type":"file","payload":{"is_reusable":true}}}`);
        return { ok: true, attachmentId: "dry-run-attachment-1", status: 200, errorCode: null, errorSubcode: null, errorMessage: null };
      },
      sendFile: async (recipientId, attachmentId) => {
        add("POST /me/messages", "file attachment by attachment_id", fb.buildFbFileMessageBody(recipientId, { attachmentId }));
        return { ok: true, status: 200, errorCode: null, errorSubcode: null, errorMessage: null, messageId: "m_dry_run_file", recipientId };
      },
      sendDirectText: async (recipientId, text) => {
        add("POST /me/messages", "text", { messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text, metadata: messenger.BOT_MESSAGE_METADATA } });
        return true;
      },
      assertMaySend: async () => {},
      recordFile: async () => {},
      recordOutbound: async () => {},
      publicFileUrl: () => publicUrl,
      websiteUrl: () => snapshot.contact.siteUrl,
    },
  });

  // ── 4. Report ──────────────────────────────────────────────────────────────────────────────
  const fileSteps = steps.filter((step) => step.detail.startsWith("file attachment")).length;
  const textSteps = steps.filter((step) => step.detail === "text").length;
  const imageSteps = steps.filter((step) => JSON.stringify(step.body ?? "").includes('"type":"image"')).length;
  const lines: string[] = [];
  lines.push("", "================ CATALOGUE DRY RUN (nothing stored, nothing sent) ================");
  lines.push(`Edition        ${edition}  |  trips ${snapshot.trips.length}  |  built ${snapshot.issueLabel}  |  render ${Math.round((Date.now() - started) / 100) / 10}s${noPhotos ? "  |  photos off" : ""}`);
  lines.push(`File           ${fileName}`);
  lines.push(`Size / pages   ${mb(rendered.pdf.length)} (${rendered.pdf.length} bytes) / ${rendered.pageCount} pages, ${rendered.pageSize.width}x${rendered.pageSize.height} pt`);
  lines.push(`Version label  ${versionLabel}  (v${versionNo}, content ${snapshot.contentHash.slice(0, 12)})`);
  lines.push(`Public link    ${publicUrl}   (used only if Meta would not take the file)`);
  lines.push("", `Freshness      ${verdict.state.toUpperCase()}${verdict.ageDays !== null ? `  (age ${verdict.ageDays.toFixed(2)} days)` : ""}${verdict.reasons.length ? `\n               - ${verdict.reasons.join("\n               - ")}` : ""}`);
  lines.push("", `Delivery       ${outcome.status}  fileAccepted=${outcome.fileAccepted}${outcome.reason ? `  reason=${outcome.reason}` : ""}`);
  lines.push(`Payloads a customer would receive (recipient ${DRY_RECIPIENT}):`);
  for (const step of steps) {
    lines.push(`  ${step.n}. ${step.request}  ${step.detail}`);
    if (step.body) lines.push(`     ${JSON.stringify(step.body)}`);
  }
  lines.push(`  Totals: ${textSteps} text, ${fileSteps} file attachment, ${imageSteps} image attachments, ${steps.filter((s) => s.request.includes("message_attachments")).length} upload`);
  if (textSteps !== 1 || fileSteps !== 1 || imageSteps !== 0) lines.push("  !! EXPECTED exactly 1 text and 1 file attachment and no image: read the delivery status above.");
  lines.push(`Staff lead     ${leads.length ? leads.map((lead) => `${lead.status}: ${lead.reason}`).join(" | ") : "none (a clean send needs none)"}`);
  lines.push("", "Trips");
  for (const card of snapshot.trips) {
    lines.push(`  ${card.code}${provisional.has(card.tripId) ? "*" : " "} ${card.title.slice(0, 44).padEnd(44)} ${card.price.display.padEnd(14)} ${card.dates.label.padEnd(26)} photo:${card.photo ? "yes" : "NO "} ${card.warnings.length ? `(${card.warnings.length} warning${card.warnings.length > 1 ? "s" : ""})` : ""}`);
  }
  if (provisional.size) lines.push("  * provisional code (the trip has no stored code yet; the admin allocates it on the first Generate)");
  lines.push("", `Warnings (${warnings.length}): ${warnings.filter((w) => w.severity === "blocking").length} blocking, ${warnings.filter((w) => w.severity === "warning").length} warning, ${warnings.filter((w) => w.severity === "info").length} info`);
  if (noPhotos) lines.push("  (--no-photos: every photo_fetch_failed warning below is expected; run without it to see the real photo warnings)");
  for (const warning of warnings) lines.push(`  [${warning.severity}] ${warning.code}${warning.tripId ? ` ${warning.tripId.slice(0, 8)}` : ""}: ${warning.message}`);
  if (!phones.length) lines.push("  !! No contact phone is configured: the closing page would print none (blocking).");
  lines.push("=====================================================================================", "");
  console.log(lines.join("\n"));

  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, fileName), rendered.pdf);
    await writeFile(path.join(outDir, "report.json"), JSON.stringify({ outcome, verdict, steps, warnings, leads, trips: snapshot.trips.map((c) => ({ code: c.code, title: c.title, price: c.price.display, dates: c.dates.label })) }, null, 2));
    console.log(`Wrote ${path.join(outDir, fileName)} and report.json`);
  }
}

// Chromium can take a long time to exit on a busy Windows box; everything is already printed.
main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[database]") : error);
  process.exit(1);
});
