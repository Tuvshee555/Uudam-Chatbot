/**
 * Strict, dependency-free input validation for the catalogue admin API.
 *
 * Every body is parsed here and nowhere else: unknown keys are rejected, ids and counts are
 * bounded, and every failure carries a Mongolian message the admin can show as is.
 */

import {
  CATALOGUE_QUICK_MAX_TRIPS,
  CATALOGUE_QUICK_MIN_TRIPS,
  type CatalogueEdition,
  type CatalogueEditionConfig,
} from "../types";
import {
  ADMIN_EDITIONS,
  CATALOGUE_PREVIEW_MAX_TRIPS,
  CATALOGUE_PREVIEW_MIN_TRIPS,
  PUBLISHABLE_EDITIONS,
} from "./types";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Trip ids come from the trip store (slugs, possibly Mongolian letters); never anything with path or markup characters. */
const TRIP_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,119}$/u;
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GROUP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PSID_PATTERN = /^\d{5,32}$/;
const REF_PATTERN = /^[a-f0-9]{16}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_COMPLETE_ORDER_IDS = 500;
export const MAX_GROUP_OVERRIDES = 500;
export const MAX_ID_LIST = 500;

export function isValidTripId(value: unknown): value is string {
  return typeof value === "string" && TRIP_ID_PATTERN.test(value);
}

export function isValidVersionId(value: unknown): value is string {
  return typeof value === "string" && VERSION_ID_PATTERN.test(value);
}

export function isValidPsid(value: unknown): value is string {
  return typeof value === "string" && PSID_PATTERN.test(value);
}

export function isValidRecipientRef(value: unknown): value is string {
  return typeof value === "string" && REF_PATTERN.test(value);
}

export function isValidTesterId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bodies arrive parsed by Next; a raw JSON string (odd content-type) is accepted too. */
export function readBody(body: unknown): Record<string, unknown> | null {
  if (isPlainObject(body)) return body;
  if (typeof body === "string" && body.trim()) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

export function parseEdition(
  value: unknown,
  allowed: readonly CatalogueEdition[] = ADMIN_EDITIONS,
): CatalogueEdition | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as CatalogueEdition) : null;
}

const EDITION_MESSAGE = "Каталогийн төрөл буруу байна (quick, complete эсвэл preview).";

/** Allowed number of hand-picked trips for an edition. Complete is automatic, so only a ceiling. */
export function selectionBounds(edition: CatalogueEdition): { min: number; max: number } {
  if (edition === "quick") return { min: CATALOGUE_QUICK_MIN_TRIPS, max: CATALOGUE_QUICK_MAX_TRIPS };
  if (edition === "preview") return { min: CATALOGUE_PREVIEW_MIN_TRIPS, max: CATALOGUE_PREVIEW_MAX_TRIPS };
  return { min: 0, max: MAX_COMPLETE_ORDER_IDS };
}

/** Mongolian explanation when `count` is outside what the edition allows, else null. */
export function selectionBoundsMessage(edition: CatalogueEdition, count: number): string | null {
  const { min, max } = selectionBounds(edition);
  if (edition === "complete") return count > max ? `Дараалал ${max}-аас их байж болохгүй.` : null;
  const label = edition === "quick" ? "Хурдан каталогт" : "Дээжийн каталогт";
  if (count > max) return `${label} хамгийн ихдээ ${max} аялал сонгоно (одоо ${count}).`;
  if (count < min) return `${label} дор хаяж ${min} аялал сонгоно (одоо ${count}).`;
  return null;
}

function parseIdList(value: unknown, field: string, max: number): Parsed<string[]> {
  if (!Array.isArray(value)) return fail(`"${field}" жагсаалт байх ёстой.`);
  if (value.length > max) return fail(`"${field}" ${max}-аас олон байж болохгүй.`);
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidTripId(item)) return fail(`"${field}" дотор буруу аяллын код байна.`);
    if (seen.has(item)) return fail(`"${field}" дотор ижил аялал давхардсан байна.`);
    seen.add(item);
  }
  return { ok: true, value: [...seen] };
}

export type ConfigUpdate = {
  edition: CatalogueEdition;
  config: CatalogueEditionConfig;
  /** The `updatedAt` the editor was loaded with; the store refuses the save if someone else saved since. */
  expectedUpdatedAt: string | null | undefined;
};

/**
 * PUT /config body: { edition, config: { tripIds, featuredTripIds, groupOverrides, excludedTripIds } }.
 * The whole edition's curation is replaced in one write so the stored state is always coherent.
 * Quick / preview selections must be inside their bounds (an empty list clears the selection).
 */
export function parseConfigUpdate(raw: unknown): Parsed<ConfigUpdate> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["edition", "config", "expectedUpdatedAt"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  const edition = parseEdition(body.edition);
  if (!edition) return fail(EDITION_MESSAGE);
  let expectedUpdatedAt: string | null | undefined;
  if (body.expectedUpdatedAt !== undefined) {
    if (body.expectedUpdatedAt === null) expectedUpdatedAt = null;
    else if (typeof body.expectedUpdatedAt === "string" && !Number.isNaN(Date.parse(body.expectedUpdatedAt)) && body.expectedUpdatedAt.length <= 40) {
      expectedUpdatedAt = body.expectedUpdatedAt;
    } else return fail('"expectedUpdatedAt" огноо байх ёстой.');
  }
  const config = body.config;
  if (!isPlainObject(config)) return fail('"config" объект байх ёстой.');
  const configExtra = unknownKeys(config, ["tripIds", "featuredTripIds", "groupOverrides", "excludedTripIds"]);
  if (configExtra.length) return fail(`Үл мэдэгдэх талбар: ${configExtra.join(", ")}.`);

  const tripIds = parseIdList(config.tripIds ?? [], "tripIds", selectionBounds(edition).max);
  if (!tripIds.ok) return tripIds;
  const featured = parseIdList(config.featuredTripIds ?? [], "featuredTripIds", MAX_ID_LIST);
  if (!featured.ok) return featured;
  const excluded = parseIdList(config.excludedTripIds ?? [], "excludedTripIds", MAX_ID_LIST);
  if (!excluded.ok) return excluded;

  const overridesRaw = config.groupOverrides ?? {};
  if (!isPlainObject(overridesRaw)) return fail('"groupOverrides" объект байх ёстой.');
  const overrideKeys = Object.keys(overridesRaw);
  if (overrideKeys.length > MAX_GROUP_OVERRIDES) return fail("Бүлгийн тохиргоо хэт олон байна.");
  const groupOverrides: Record<string, string> = {};
  for (const [tripId, groupKey] of Object.entries(overridesRaw)) {
    if (!isValidTripId(tripId)) return fail("Бүлгийн тохиргоонд буруу аяллын код байна.");
    if (typeof groupKey !== "string" || !GROUP_KEY_PATTERN.test(groupKey)) {
      return fail("Бүлгийн түлхүүр буруу байна.");
    }
    groupOverrides[tripId] = groupKey;
  }

  if (edition !== "complete") {
    if (tripIds.value.length > 0) {
      const boundsMessage = selectionBoundsMessage(edition, tripIds.value.length);
      if (boundsMessage) return fail(boundsMessage);
    }
    const selected = new Set(tripIds.value);
    if (featured.value.some((id) => !selected.has(id))) {
      return fail("Онцлох аялал сонгосон жагсаалтад байх ёстой.");
    }
    if (excluded.value.some((id) => selected.has(id))) {
      return fail("Хасагдсан аялал сонгосон жагсаалтад байж болохгүй.");
    }
  }

  return {
    ok: true,
    value: {
      edition,
      expectedUpdatedAt,
      config: {
        tripIds: tripIds.value,
        featuredTripIds: featured.value,
        groupOverrides,
        excludedTripIds: excluded.value,
      },
    },
  };
}

export function parseGenerateBody(raw: unknown): Parsed<{ edition: CatalogueEdition }> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["edition"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  const edition = parseEdition(body.edition);
  return edition ? { ok: true, value: { edition } } : fail(EDITION_MESSAGE);
}

export function parsePublishBody(raw: unknown): Parsed<{ versionId: string; acknowledgeWarnings: boolean }> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["versionId", "acknowledgeWarnings"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  if (!isValidVersionId(body.versionId)) return fail("Хувилбарын дугаар буруу байна.");
  if (body.acknowledgeWarnings !== undefined && typeof body.acknowledgeWarnings !== "boolean") {
    return fail('"acknowledgeWarnings" true эсвэл false байх ёстой.');
  }
  return { ok: true, value: { versionId: body.versionId, acknowledgeWarnings: body.acknowledgeWarnings === true } };
}

export function parseRollbackBody(raw: unknown): Parsed<{ versionId: string }> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["versionId"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  if (!isValidVersionId(body.versionId)) return fail("Хувилбарын дугаар буруу байна.");
  return { ok: true, value: { versionId: body.versionId } };
}

export type TestSendRequest = {
  /** Null when a specific version is named; the version's own edition then applies. */
  edition: CatalogueEdition | null;
  /** Test this exact draft/published version instead of the published one. */
  versionId: string | null;
  /** Real send only when the caller said so explicitly. Default is the safe dry-run. */
  dryRun: boolean;
  recipientPsid: string | null;
  recipientRef: string | null;
  /** A verified tester (paired with a one-time code), by opaque id. */
  testerId: string | null;
};

export function parseTestSendBody(raw: unknown): Parsed<TestSendRequest> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["edition", "versionId", "dryRun", "recipientPsid", "recipientRef", "testerId", "confirm"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  let versionId: string | null = null;
  if (body.versionId !== undefined && body.versionId !== null && body.versionId !== "") {
    if (!isValidVersionId(body.versionId)) return fail("Хувилбарын дугаар буруу байна.");
    versionId = body.versionId;
  }
  let edition: CatalogueEdition | null = null;
  if (body.edition !== undefined || !versionId) {
    edition = parseEdition(body.edition, PUBLISHABLE_EDITIONS);
    if (!edition) return fail("Туршилтын илгээлт зөвхөн quick эсвэл complete каталогт боломжтой.");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return fail('"dryRun" true эсвэл false байх ёстой.');
  const dryRun = body.dryRun !== false;
  let recipientPsid: string | null = null;
  if (body.recipientPsid !== undefined && body.recipientPsid !== null && body.recipientPsid !== "") {
    if (!isValidPsid(body.recipientPsid)) return fail("Хүлээн авагчийн ID буруу байна.");
    recipientPsid = body.recipientPsid;
  }
  let recipientRef: string | null = null;
  if (body.recipientRef !== undefined && body.recipientRef !== null && body.recipientRef !== "") {
    if (!isValidRecipientRef(body.recipientRef)) return fail("Хүлээн авагчийн лавлагаа буруу байна.");
    recipientRef = body.recipientRef;
  }
  let testerId: string | null = null;
  if (body.testerId !== undefined && body.testerId !== null && body.testerId !== "") {
    if (!isValidTesterId(body.testerId)) return fail("Туршигчийн дугаар буруу байна.");
    testerId = body.testerId;
  }
  if ([recipientPsid, recipientRef, testerId].filter(Boolean).length > 1) return fail("Хүлээн авагчийг нэг л аргаар заана.");
  if (!dryRun) {
    if (body.confirm !== true) return fail("Жинхэнэ илгээлтийн өмнө баталгаажуулалт шаардлагатай.");
    if (!recipientPsid && !recipientRef && !testerId) return fail("Жинхэнэ илгээлтэд хүлээн авагч заавал шаардлагатай.");
  }
  return { ok: true, value: { edition, versionId, dryRun, recipientPsid, recipientRef, testerId } };
}

/** Query value that may arrive as string | string[] | undefined. */
export function firstQuery(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export function parseBoundedInt(value: string, min: number, max: number, fallback: number): number {
  if (!/^\d{1,4}$/.test(value)) return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Page number in a /page/<n> URL: 1-based, positive integer. */
export function parsePageNumber(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 400 ? n : null;
}

/** The comma separated env allowlist, valid PSIDs only, unique. */
export function parsePsidAllowlist(raw: string | undefined | null): string[] {
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const value = part.trim();
    if (PSID_PATTERN.test(value)) seen.add(value);
  }
  return [...seen];
}
