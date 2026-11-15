/**
 * Public surface of the catalogue store (Neon). Import from here, not from the parts.
 *
 *   schema.ts    tables, schema ensure, clock/ids, transaction helpers, audit
 *   config.ts    admin curation (which trips, order, featured, excluded)
 *   codes.ts     stable trip codes A01..
 *   versions.ts  immutable PDF versions, publish pointer, rollback, pruning
 *   sendLog.ts   idempotent send claims, outcomes, stats, Meta attachment-id cache
 */
export {
  CATALOGUE_EDITIONS,
  CATALOGUE_MAX_PDF_BYTES,
  CATALOGUE_SCHEMA_STATEMENTS,
  CATALOGUE_TABLES,
  CatalogueStoreError,
  ensureCatalogueSchema,
  isCatalogueEdition,
  setCatalogueRuntimeForTests,
  resetCatalogueSchemaForTests,
  ulaanbaatarDay,
} from "./schema";
export type { CatalogueAuditAction, CatalogueStoreErrorCode } from "./schema";

export {
  defaultCatalogueConfig,
  emptyEditionConfig,
  getCatalogueConfig,
  sanitizeCatalogueConfig,
  sanitizeEditionConfig,
  saveCatalogueConfig,
} from "./config";

export {
  CATALOGUE_MAX_TRIP_CODES,
  assignTripCodes,
  codeForSeq,
  getTripCodeMap,
  normalizeTripCode,
  resolveTripCode,
  seqForCode,
} from "./codes";

export {
  buildVersionFileName,
  getPublicFileByToken,
  getPublicFileMetaByToken,
  getPublished,
  getVersionMeta,
  getVersionPageImage,
  getVersionPdf,
  getVersionSnapshot,
  listCatalogueAudit,
  listVersions,
  publishVersion,
  pruneOldVersions,
  rollbackTo,
  saveDraftVersion,
} from "./versions";
export type { CatalogueAuditEntry } from "./versions";

export {
  CLAIM_IN_FLIGHT_MS,
  DEFAULT_SEND_WINDOW_MS,
  EXPLICIT_RESEND_BURST_MS,
  cacheFbAttachment,
  claimSend,
  clearCachedFbAttachment,
  deliveryStats,
  finishSend,
  getCachedFbAttachment,
  hashCatalogueSender,
} from "./sendLog";
export type { CatalogueDeliveryStats, ClaimSendInput, ClaimSendResult } from "./sendLog";
