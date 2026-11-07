/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Catalogue store: schema, trip codes, config, versions (draft -> publish -> rollback), pruning,
 * the public file route, send claims and stats.
 *
 * No real Postgres here: every statement the store sends carries a `/* cat:<name> *\/` tag and the
 * in-memory FakeDb below implements each tag with the same semantics the SQL has (unique
 * constraints, the one-published-per-edition index, transaction advisory locks, rollback). The
 * SQL itself was run against a real Postgres engine separately; these tests pin the TypeScript
 * logic around it. Invented names only.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type {
  CatalogueEdition,
  CatalogueSnapshot,
  CatalogueTripCard,
  CatalogueWarning,
  RenderedCatalogue,
} from "../src/lib/catalogue/types";

// ---------------------------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------------------------

type Row = Record<string, any>;

function uniqueViolation(what: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${what}"`), { code: "23505" });
}

const dayOf = (value: unknown): string => new Date(new Date(String(value)).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

class FakeClient {
  undo: Array<() => void> = [];
  held = new Set<string>();
  inTx = false;
  constructor(private readonly db: FakeDb) {}

  async query(sql: string, params: unknown[] = []) {
    await new Promise((resolve) => setImmediate(resolve));
    const text = sql.trim();
    if (/^BEGIN/i.test(text)) {
      this.inTx = true;
      this.undo = [];
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT/i.test(text)) {
      this.finish();
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK/i.test(text)) {
      for (const fn of this.undo.reverse()) fn();
      this.finish();
      return { rows: [], rowCount: 0 };
    }
    if (/pg_advisory_xact_lock/.test(text)) {
      await this.db.lock(this, String(params[0]));
      return { rows: [], rowCount: 0 };
    }
    const tag = /\/\*\s*cat:(\w+)\s*\*\//.exec(text)?.[1];
    if (!tag) throw new Error(`untagged statement: ${text.slice(0, 80)}`);
    this.db.queries.push(tag);
    this.db.sqlByTag[tag] = text;
    const injected = this.db.takeFailure(tag);
    if (injected) throw injected;
    const handler = (this.db.handlers as Record<string, (c: FakeClient, p: any[]) => { rows: Row[]; rowCount: number }>)[tag];
    if (!handler) throw new Error(`FakeDb has no handler for cat:${tag}`);
    const result = handler(this, params as any[]);
    if (!this.inTx) this.undo = [];
    return result;
  }

  release() {
    this.finish();
  }

  private finish() {
    this.undo = [];
    this.inTx = false;
    this.db.unlockAll(this);
  }

  insert(table: Row[], row: Row) {
    table.push(row);
    this.undo.push(() => {
      const index = table.indexOf(row);
      if (index >= 0) table.splice(index, 1);
    });
  }

  update(row: Row, patch: Row) {
    const previous = { ...row };
    Object.assign(row, patch);
    this.undo.push(() => {
      for (const key of Object.keys(patch)) row[key] = previous[key];
    });
  }

  remove(table: Row[], predicate: (row: Row) => boolean): Row[] {
    const removed = table.filter(predicate);
    for (const row of removed) table.splice(table.indexOf(row), 1);
    this.undo.push(() => table.push(...removed));
    return removed;
  }
}

const META_KEYS = [
  "id", "edition", "version_no", "file_name", "status", "size_bytes", "page_count", "sha256", "content_hash",
  "trip_count", "warnings", "public_token", "generated_at", "generated_by", "published_at", "published_by",
];
const metaOf = (row: Row): Row => Object.fromEntries(META_KEYS.map((key) => [key, row[key]]));
const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

class FakeDb {
  versions: Row[] = [];
  pages: Row[] = [];
  config: Row | null = null;
  codes: Row[] = [];
  sends: Row[] = [];
  fbs: Row[] = [];
  audit: Row[] = [];
  auditSeq = 0;
  ddlRuns = 0;
  queries: string[] = [];
  sqlByTag: Record<string, string> = {};
  honorLocks = true;
  failures: Array<{ tag: string; error: Error; times: number }> = [];
  locks = new Map<string, FakeClient>();
  waiters = new Map<string, Array<() => void>>();

  takeFailure(tag: string): Error | null {
    const failure = this.failures.find((item) => item.tag === tag && item.times > 0);
    if (!failure) return null;
    failure.times -= 1;
    return failure.error;
  }

  async lock(client: FakeClient, key: string) {
    if (!this.honorLocks) return;
    for (;;) {
      const holder = this.locks.get(key);
      if (!holder || holder === client) {
        this.locks.set(key, client);
        client.held.add(key);
        return;
      }
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(key) ?? [];
        list.push(resolve);
        this.waiters.set(key, list);
      });
    }
  }

  unlockAll(client: FakeClient) {
    for (const key of client.held) {
      this.locks.delete(key);
      for (const wake of this.waiters.get(key)?.splice(0) ?? []) wake();
    }
    client.held.clear();
  }

  private version(id: unknown) {
    return this.versions.find((row) => row.id === id);
  }

  handlers: Record<string, (c: FakeClient, p: any[]) => { rows: Row[]; rowCount: number }> = {
    ddl: () => {
      this.ddlRuns += 1;
      return ok();
    },
    audit_insert: (c, p) => {
      c.insert(this.audit, { id: ++this.auditSeq, action: p[0], actor: p[1], edition: p[2], version_id: p[3], detail: JSON.parse(p[4]), at: p[5] });
      return ok([], 1);
    },
    // config
    config_get: () => ok(this.config ? [{ ...this.config }] : []),
    config_lock: () => ok(this.config ? [{ ...this.config }] : []),
    config_upsert: (c, p) => {
      const next = { data: JSON.parse(p[0]), updated_at: p[1], updated_by: p[2] };
      if (this.config) c.update(this.config, next);
      else {
        this.config = next;
        c.undo.push(() => {
          this.config = null;
        });
      }
      return ok([], 1);
    },
    // codes
    codes_by_trip: (_c, p) => ok(this.codes.filter((row) => (p[0] as string[]).includes(row.trip_id)).map((row) => ({ trip_id: row.trip_id, code: row.code }))),
    codes_max_seq: () => ok([{ max_seq: this.codes.length ? Math.max(...this.codes.map((row) => row.seq)) : null }]),
    codes_insert: (c, p) => {
      if (this.codes.some((row) => row.trip_id === p[0])) throw uniqueViolation("catalogue_codes_pkey");
      if (this.codes.some((row) => row.seq === p[1])) throw uniqueViolation("catalogue_codes_seq_key");
      if (this.codes.some((row) => row.code === p[2])) throw uniqueViolation("catalogue_codes_code_key");
      c.insert(this.codes, { trip_id: p[0], seq: p[1], code: p[2], assigned_at: p[3] });
      return ok([], 1);
    },
    codes_all: () => ok([...this.codes].sort((a, b) => a.seq - b.seq).map((row) => ({ trip_id: row.trip_id, code: row.code }))),
    codes_resolve: (_c, p) => ok(this.codes.filter((row) => row.code === p[0]).map((row) => ({ trip_id: row.trip_id }))),
    // versions
    version_next_no: (_c, p) => ok([{ next_no: Math.max(0, ...this.versions.filter((row) => row.edition === p[0]).map((row) => row.version_no)) + 1 }]),
    version_insert: (c, p) => {
      if (this.versions.some((row) => row.public_token === p[12])) throw uniqueViolation("catalogue_versions_public_token_key");
      if (this.versions.some((row) => row.edition === p[1] && row.version_no === p[2])) throw uniqueViolation("catalogue_versions_edition_version_no_key");
      c.insert(this.versions, {
        id: p[0], edition: p[1], version_no: p[2], file_name: p[3], status: "draft", bytes: p[4], size_bytes: p[5],
        page_count: p[6], sha256: p[7], content_hash: p[8], trip_count: p[9], snapshot: JSON.parse(p[10]),
        warnings: JSON.parse(p[11]), public_token: p[12], generated_at: p[13], generated_by: p[14],
        published_at: null, published_by: null,
      });
      return ok([], 1);
    },
    page_insert: (c, p) => {
      c.insert(this.pages, { version_id: p[0], page_no: p[1], jpeg: p[2] });
      return ok([], 1);
    },
    versions_list_edition: (_c, p) =>
      ok(this.versions.filter((row) => row.edition === p[0]).sort((a, b) => b.version_no - a.version_no).slice(0, p[1]).map(metaOf)),
    versions_list_all: (_c, p) =>
      ok([...this.versions].sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)) || b.version_no - a.version_no).slice(0, p[0]).map(metaOf)),
    version_meta: (_c, p) => ok(this.version(p[0]) ? [metaOf(this.version(p[0])!)] : []),
    version_pdf: (_c, p) => ok(this.version(p[0]) ? [{ ...metaOf(this.version(p[0])!), bytes: this.version(p[0])!.bytes }] : []),
    page_get: (_c, p) => ok(this.pages.filter((row) => row.version_id === p[0] && row.page_no === p[1]).map((row) => ({ jpeg: row.jpeg }))),
    version_snapshot: (_c, p) => ok(this.version(p[0]) ? [{ snapshot: this.version(p[0])!.snapshot }] : []),
    published_get: (_c, p) => ok(this.versions.filter((row) => row.edition === p[0] && row.status === "published").slice(0, 1).map(metaOf)),
    public_meta: (_c, p) => ok(this.versions.filter((row) => row.public_token === p[0] && row.status !== "draft").map(metaOf)),
    public_file: (_c, p) => ok(this.versions.filter((row) => row.public_token === p[0] && row.status !== "draft").map((row) => ({ ...metaOf(row), bytes: row.bytes }))),
    version_edition: (_c, p) => ok(this.version(p[0]) ? [{ edition: this.version(p[0])!.edition }] : []),
    version_for_update: (_c, p) => ok(this.version(p[0]) ? [metaOf(this.version(p[0])!)] : []),
    publish_supersede: (c, p) => {
      const rows = this.versions.filter((row) => row.edition === p[0] && row.status === "published" && row.id !== p[1]);
      for (const row of rows) c.update(row, { status: "superseded" });
      return ok(rows.map((row) => ({ id: row.id })));
    },
    publish_activate: (c, p) => {
      const row = this.version(p[0])!;
      if (this.versions.some((other) => other !== row && other.edition === row.edition && other.status === "published")) {
        throw uniqueViolation("catalogue_versions_one_published");
      }
      c.update(row, { status: "published", published_at: p[1], published_by: p[2] });
      return ok([], 1);
    },
    versions_prune: (c, p) => {
      const doomed = new Set<string>();
      for (const edition of new Set(this.versions.map((row) => row.edition))) {
        const ranked = this.versions.filter((row) => row.edition === edition).sort((a, b) => b.version_no - a.version_no);
        ranked.forEach((row, index) => {
          if (index + 1 > p[0] && row.status !== "published") doomed.add(row.id);
        });
      }
      const removed = c.remove(this.versions, (row) => doomed.has(row.id));
      c.remove(this.pages, (row) => doomed.has(row.version_id));
      c.remove(this.fbs, (row) => doomed.has(row.version_id));
      return ok(removed.map((row) => ({ id: row.id, edition: row.edition })));
    },
    audit_list: (_c, p) => ok([...this.audit].sort((a, b) => b.id - a.id).slice(0, p[0])),
    // sends
    send_suppressed: (c, p) => {
      const row = this.sends.find((item) => item.id === p[0])!;
      c.update(row, { suppressed_count: row.suppressed_count + 1 });
      return ok([], 1);
    },
    send_by_dedupe: (_c, p) => ok(this.sends.filter((row) => row.sender_hash === p[0] && row.dedupe_key === p[1]).slice(0, 1).map((row) => ({ id: row.id, status: row.status, created_at: row.created_at }))),
    send_reopen: (c, p) => {
      const row = this.sends.find((item) => item.id === p[0])!;
      c.update(row, { status: "claimed", version_id: p[1], explicit_resend: p[2], created_at: p[3], finished_at: null, meta_message_id: null, reason: null });
      return ok([], 1);
    },
    send_recent: (_c, p) =>
      ok(
        this.sends
          .filter((row) => row.sender_hash === p[0] && row.edition === p[1] && new Date(row.created_at) > new Date(p[2]) && ["claimed", "sent", "sent_link_fallback", "stale_fallback"].includes(row.status))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 10)
          .map((row) => ({ id: row.id, status: row.status, created_at: row.created_at, version_id: row.version_id })),
      ),
    send_insert: (c, p) => {
      if (p[5] && this.sends.some((row) => row.sender_hash === p[1] && row.dedupe_key === p[5])) throw uniqueViolation("catalogue_sends_dedupe");
      c.insert(this.sends, {
        id: p[0], sender_hash: p[1], edition: p[2], version_id: p[3], status: "claimed", meta_message_id: null, reason: null,
        retries: 0, explicit_resend: p[4], dedupe_key: p[5], suppressed_count: 0, created_at: p[6], finished_at: null,
      });
      return ok([], 1);
    },
    send_finish: (c, p) => {
      const row = this.sends.find((item) => item.id === p[0]);
      if (!row) return ok([], 0);
      c.update(row, { status: p[1], meta_message_id: p[2], reason: p[3], retries: p[4], finished_at: p[5] });
      return ok([], 1);
    },
    stats_groups: (_c, p) => {
      const groups = new Map<string, Row>();
      for (const row of this.sends) {
        const at = new Date(row.created_at).getTime();
        if (at < new Date(p[0]).getTime() || at > new Date(p[1]).getTime()) continue;
        const version = this.versions.find((item) => item.id === row.version_id);
        const day = dayOf(row.created_at);
        const key = [row.status, row.edition, row.version_id, day].join("|");
        const group = groups.get(key) ?? {
          status: row.status, edition: row.edition, version_id: row.version_id, version_no: version?.version_no ?? null,
          file_name: version?.file_name ?? null, day, n: 0, suppressed: 0, last_at: row.created_at,
        };
        group.n += 1;
        group.suppressed += row.suppressed_count;
        if (String(row.created_at) > String(group.last_at)) group.last_at = row.created_at;
        groups.set(key, group);
      }
      return ok([...groups.values()]);
    },
    stats_unique: (_c, p) => {
      const hashes = new Set(
        this.sends
          .filter((row) => new Date(row.created_at) >= new Date(p[0]) && new Date(row.created_at) <= new Date(p[1]) && ["sent", "sent_link_fallback", "stale_fallback"].includes(row.status))
          .map((row) => row.sender_hash),
      );
      return ok([{ n: hashes.size }]);
    },
    // fb attachment cache
    fb_get: (_c, p) => ok(this.fbs.filter((row) => row.version_id === p[0] && row.page_id === p[1]).map((row) => ({ attachment_id: row.attachment_id }))),
    fb_put: (c, p) => {
      if (!this.version(p[0])) throw Object.assign(new Error("foreign key violation"), { code: "23503" });
      const existing = this.fbs.find((row) => row.version_id === p[0] && row.page_id === p[1]);
      if (existing) c.update(existing, { attachment_id: p[2], created_at: p[3] });
      else c.insert(this.fbs, { version_id: p[0], page_id: p[1], attachment_id: p[2], created_at: p[3] });
      return ok([], 1);
    },
    fb_clear: (c, p) => {
      const removed = c.remove(this.fbs, (row) => row.version_id === p[0] && row.page_id === p[1]);
      return ok([], removed.length);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let db = new FakeDb();
let nowMs = Date.parse("2026-11-06T03:00:00.000Z");
let uuidCounter = 0;
let tokenCounter = 0;
let S: typeof import("../src/lib/catalogue/store");
let SCHEMA: typeof import("../src/lib/catalogue/schema");
let ROUTE: typeof import("../src/pages/api/catalogue/file/[token]");
let RATE: typeof import("../src/lib/rateLimit");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const advance = (ms: number) => {
  nowMs += ms;
};
const fakeUuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;
const fakeToken = () => `T${String(++tokenCounter).padStart(31, "0")}`;

before(async () => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/catalogue-fixture" });
  const { Pool } = await import("pg");
  mock.method(Pool.prototype, "query", (async (sql: string, params?: unknown[]) => new FakeClient(db).query(sql, params ?? [])) as any);
  mock.method(Pool.prototype, "connect", (async () => new FakeClient(db)) as any);
  S = await import("../src/lib/catalogue/store");
  SCHEMA = await import("../src/lib/catalogue/schema");
  ROUTE = await import("../src/pages/api/catalogue/file/[token]");
  RATE = await import("../src/lib/rateLimit");
});

after(async () => {
  mock.restoreAll();
  SCHEMA?.setCatalogueRuntimeForTests(null);
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});

beforeEach(() => {
  db = new FakeDb();
  nowMs = Date.parse("2026-11-06T03:00:00.000Z");
  uuidCounter = 0;
  tokenCounter = 0;
  RATE.resetRateLimitForTests();
  SCHEMA.resetCatalogueSchemaForTests();
  SCHEMA.setCatalogueRuntimeForTests({ now: () => new Date(nowMs), uuid: fakeUuid, token: fakeToken });
});

function trip(id: string, title: string): CatalogueTripCard {
  return {
    tripId: id, code: "A01", title, editorialTitle: title, destinationKey: "", heroQuality: "missing", gallery: [], kicker: "Жишиг", groupKey: "beach", durationText: "5 өдөр / 4 шөнө", transportLabel: "Газрын аялал",
    highlights: ["Жишиг онцлог"], price: { kind: "from", amountMnt: 1_000_000, date: "2027-01-09", display: "1,000,000₮-с" },
    dates: { nextDeparture: "2027-01-09", departures: ["2027-01-09"], label: "2027.01.09-ний хөдлөлт" }, detailUrl: null, photo: null, warnings: [],
  };
}

function snapshot(edition: CatalogueEdition = "quick", warnings: CatalogueWarning[] = []): CatalogueSnapshot {
  return {
    edition, generatedAt: new Date(nowMs).toISOString(), asOfDay: "2026-11-06", issueLabel: "2026.11.06", seasonLabel: "2026 / 2027",
    trips: [trip("trip-dalai", "Тест-Далай"), trip("trip-hodoo", "Жишиг-Хөдөө")], coverTripId: null, groups: [], contact: { phones: ["99990000"], siteLabel: "example.test", siteUrl: "https://example.test" },
    warnings, contentHash: `hash-${edition}`,
  };
}

const pdfBytes = (extra = 64) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(extra, 7), Buffer.from("\n%%EOF")]);

function rendered(extra = 64, warnings: CatalogueWarning[] = [], pages = 2): RenderedCatalogue {
  return {
    pdf: pdfBytes(extra), pageCount: pages, pageImages: Array.from({ length: pages }, (_, i) => Buffer.from([0xff, 0xd8, i + 1])),
    pageSize: { width: 540, height: 960 }, fonts: ["Noto Sans"], renderMs: 12, warnings,
  };
}

const blocking: CatalogueWarning = { code: "price_conflict", severity: "blocking", message: "Үнэ зөрсөн", tripId: "trip-dalai" };
const noteOnly: CatalogueWarning = { code: "photo_missing", severity: "warning", message: "Зураг дутуу" };

async function draft(edition: CatalogueEdition = "quick", warnings: CatalogueWarning[] = [], extra = 64) {
  advance(1000);
  return S.saveDraftVersion({ edition, snapshot: snapshot(edition), rendered: rendered(extra, warnings), actor: "staff@example.test" });
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

test("schema: every statement is idempotent and every table is catalogue_-prefixed", () => {
  for (const statement of SCHEMA.CATALOGUE_SCHEMA_STATEMENTS) {
    assert.match(statement, /^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF NOT EXISTS\s/i, statement.slice(0, 60));
  }
  const created = SCHEMA.CATALOGUE_SCHEMA_STATEMENTS.map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1]).filter(Boolean);
  assert.deepEqual([...created].sort(), [...SCHEMA.CATALOGUE_TABLES].sort());
  for (const table of created) assert.match(String(table), /^catalogue_/);
  const ddl = SCHEMA.CATALOGUE_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /catalogue_versions_one_published[\s\S]*WHERE status = 'published'/, "DB-level single published pointer");
  assert.match(ddl, /public_token TEXT NOT NULL UNIQUE/);
  assert.match(ddl, /UNIQUE \(edition, version_no\)/);
});

test("schema: ensure runs the DDL once per process, concurrent callers share one run, a reset runs it again safely", async () => {
  await Promise.all([S.ensureCatalogueSchema(), S.ensureCatalogueSchema(), S.ensureCatalogueSchema()]);
  const statements = SCHEMA.CATALOGUE_SCHEMA_STATEMENTS.length;
  assert.equal(db.ddlRuns, statements, "one run, not three");
  await S.ensureCatalogueSchema();
  assert.equal(db.ddlRuns, statements);
  S.resetCatalogueSchemaForTests();
  await S.ensureCatalogueSchema();
  assert.equal(db.ddlRuns, statements * 2, "second ensure re-runs the idempotent DDL without error");
});

test("schema: a failed ensure is not remembered, the next call retries", async () => {
  db.failures.push({ tag: "ddl", error: new Error("neon cold start"), times: 1 });
  await assert.rejects(S.ensureCatalogueSchema(), /neon cold start/);
  await S.ensureCatalogueSchema();
  assert.ok(db.ddlRuns >= SCHEMA.CATALOGUE_SCHEMA_STATEMENTS.length);
});

test("schema: public tokens are 32 URL-safe characters and never repeat", () => {
  SCHEMA.setCatalogueRuntimeForTests({ now: () => new Date(nowMs) });
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = SCHEMA.newCataloguePublicToken();
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 200);
});

// ---------------------------------------------------------------------------------------------
// Trip codes
// ---------------------------------------------------------------------------------------------

test("codes: A01..A99 then B01, round-trip, and the space ends at Z99", () => {
  assert.equal(S.codeForSeq(1), "A01");
  assert.equal(S.codeForSeq(9), "A09");
  assert.equal(S.codeForSeq(99), "A99");
  assert.equal(S.codeForSeq(100), "B01");
  assert.equal(S.codeForSeq(S.CATALOGUE_MAX_TRIP_CODES), "Z99");
  assert.throws(() => S.codeForSeq(S.CATALOGUE_MAX_TRIP_CODES + 1), (e: any) => e.code === "code_space_exhausted");
  assert.throws(() => S.codeForSeq(0), (e: any) => e.code === "invalid_input");
  for (const seq of [1, 50, 99, 100, 198, 199, 2574]) assert.equal(S.seqForCode(S.codeForSeq(seq)), seq);
  assert.equal(S.seqForCode("A00"), null);
  assert.equal(S.seqForCode("a01"), null, "canonical form only");
});

test("codes: what a customer types normalises, including Cyrillic look-alike letters", () => {
  for (const [typed, code] of [["A01", "A01"], ["a1", "A01"], ["A-01", "A01"], ["B 07", "B07"], ["А01", "A01"], ["в12", "B12"], [" c3 ", "C03"]]) {
    assert.equal(S.normalizeTripCode(typed), code, typed);
  }
  for (const bad of ["", "A00", "A100", "AA1", "01", "Я01", "A0x", "hello", "A 1 2"]) assert.equal(S.normalizeTripCode(bad), null, bad);
});

test("codes: allocation is stable, ordered, idempotent and never reuses a code", async () => {
  const first = await S.assignTripCodes(["trip-b", "trip-a", "trip-b", " ", "trip-c"]);
  assert.deepEqual(first, { "trip-b": "A01", "trip-a": "A02", "trip-c": "A03" });
  assert.deepEqual(await S.assignTripCodes(["trip-c", "trip-a"]), { "trip-c": "A03", "trip-a": "A02" });
  assert.deepEqual(await S.assignTripCodes(["trip-new"]), { "trip-new": "A04" });
  // trip-b disappears from the live data: its code stays reserved, the next trip gets a fresh one
  assert.deepEqual(await S.assignTripCodes(["trip-a", "trip-new", "trip-later"]), { "trip-a": "A02", "trip-new": "A04", "trip-later": "A05" });
  assert.deepEqual(await S.getTripCodeMap(), { "trip-b": "A01", "trip-a": "A02", "trip-c": "A03", "trip-new": "A04", "trip-later": "A05" });
  assert.deepEqual(await S.assignTripCodes([]), {});
});

test("codes: crossing A99 continues with B01", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `trip-${String(i).padStart(3, "0")}`);
  const map = await S.assignTripCodes(ids);
  assert.equal(map["trip-098"], "A99");
  assert.equal(map["trip-099"], "B01");
  assert.equal(map["trip-100"], "B02");
});

test("codes: concurrent allocations with overlapping ids never collide", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `trip-${i}`);
  const results = await Promise.all([
    S.assignTripCodes(ids.slice(0, 7)), S.assignTripCodes(ids.slice(4)), S.assignTripCodes(ids),
    S.assignTripCodes([...ids].reverse()), S.assignTripCodes(["trip-3", "trip-9", "trip-extra"]),
  ]);
  const map = await S.getTripCodeMap();
  assert.equal(Object.keys(map).length, 13);
  assert.equal(new Set(Object.values(map)).size, 13, "codes are unique");
  assert.deepEqual(Object.values(map).sort(), Array.from({ length: 13 }, (_, i) => S.codeForSeq(i + 1)).sort(), "no gaps, no duplicates");
  for (const result of results) for (const [id, code] of Object.entries(result)) assert.equal(map[id], code, "every caller saw the final code");
});

test("codes: even when advisory locks fail to serialise, the unique constraints plus retry keep codes unique", async () => {
  db.honorLocks = false;
  const ids = Array.from({ length: 8 }, (_, i) => `trip-${i}`);
  const results = await Promise.allSettled([
    S.assignTripCodes(ids), S.assignTripCodes([...ids].reverse()), S.assignTripCodes(ids.slice(2)),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  const map = await S.getTripCodeMap();
  assert.equal(new Set(Object.values(map)).size, Object.keys(map).length);
  assert.deepEqual(await S.assignTripCodes(ids), map as any);
});

test("codes: a unique violation is retried, other errors are not swallowed", async () => {
  db.failures.push({ tag: "codes_insert", error: Object.assign(new Error("dup"), { code: "23505" }), times: 1 });
  assert.deepEqual(await S.assignTripCodes(["trip-a"]), { "trip-a": "A01" });
  db.failures.push({ tag: "codes_insert", error: new Error("disk full"), times: 1 });
  await assert.rejects(S.assignTripCodes(["trip-b"]), /disk full/);
  assert.equal((await S.getTripCodeMap())["trip-b"], undefined, "the failed allocation was rolled back");
});

test("codes: resolveTripCode maps what customers type back to the trip id", async () => {
  await S.assignTripCodes(["trip-dalai", "trip-hodoo"]);
  assert.equal(await S.resolveTripCode("A01"), "trip-dalai");
  assert.equal(await S.resolveTripCode("а02"), "trip-hodoo", "Cyrillic а");
  assert.equal(await S.resolveTripCode("A-2"), "trip-hodoo");
  assert.equal(await S.resolveTripCode("A09"), null);
  assert.equal(await S.resolveTripCode("hello"), null);
});

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

test("config: sanitising drops junk, dedupes, and lets exclusion win", () => {
  const clean = S.sanitizeCatalogueConfig({
    quick: {
      tripIds: ["a", "b", "a", 7, "has space", "", "x"], excludedTripIds: ["x", "x"], featuredTripIds: ["b", "x"],
      groupOverrides: { a: "beach", b: "bad key!", "has space": "beach", c: 5 },
    },
    complete: "nonsense",
  });
  assert.deepEqual(clean.quick.tripIds, ["a", "b"]);
  assert.deepEqual(clean.quick.featuredTripIds, ["b"]);
  assert.deepEqual(clean.quick.excludedTripIds, ["x"]);
  assert.deepEqual(clean.quick.groupOverrides, { a: "beach" });
  assert.deepEqual(clean.complete, S.emptyEditionConfig());
  assert.deepEqual(S.sanitizeCatalogueConfig(null).preview, S.emptyEditionConfig());
});

test("config: hero choices and display titles are normalised; a stored config from before they existed still reads", () => {
  const clean = S.sanitizeCatalogueConfig({
    heroByTripId: {
      a: { url: "https://img.example.test/a.jpg", focal: { x: 2, y: -1 }, zoom: 9, quality: "excellent" },
      b: { url: "http://insecure.example.test/b.jpg" },
      c: { url: "https://img.example.test/c.jpg", focal: { x: 0.3, y: 0.4 }, zoom: 0.2, quality: "stellar" },
      d: { url: "https://img.example.test/d.jpg", focal: { x: "left", y: 0.5 } },
      "has space": { url: "https://img.example.test/e.jpg" },
      f: "nonsense",
    },
    titleOverrides: { a: "  Жишиг    гарчиг  ", b: "   ", c: "x".repeat(200), d: 5, "has space": "no" },
  });
  assert.deepEqual(clean.heroByTripId.a, { url: "https://img.example.test/a.jpg", focal: { x: 1, y: 0 }, zoom: 3, quality: "excellent" }, "focal clamped to 0..1, zoom to 1..3");
  assert.equal(clean.heroByTripId.b, undefined, "only https urls");
  assert.deepEqual(clean.heroByTripId.c, { url: "https://img.example.test/c.jpg", focal: { x: 0.3, y: 0.4 }, zoom: 1 }, "an unknown quality is dropped, a tiny zoom is lifted to 1");
  assert.deepEqual(clean.heroByTripId.d, { url: "https://img.example.test/d.jpg" }, "a broken focal point is dropped, the photo kept");
  assert.deepEqual(Object.keys(clean.heroByTripId).sort(), ["a", "c", "d"]);
  assert.equal(clean.titleOverrides.a, "Жишиг гарчиг", "trimmed and single-spaced");
  assert.equal([...clean.titleOverrides.c].length, 80);
  assert.deepEqual(Object.keys(clean.titleOverrides).sort(), ["a", "c"]);

  // A row saved before heroByTripId / titleOverrides existed: no overrides, nothing breaks.
  const legacy = S.sanitizeCatalogueConfig({ quick: { tripIds: ["a"] }, complete: {}, preview: {} });
  assert.deepEqual(legacy.heroByTripId, {});
  assert.deepEqual(legacy.titleOverrides, {});
  assert.deepEqual(legacy.quick.tripIds, ["a"]);
  assert.deepEqual(S.sanitizeCatalogueConfig(null).heroByTripId, {});
});

test("config: hero choices and titles are saved with the curation and read back", async () => {
  const saved = await S.saveCatalogueConfig({
    quick: { tripIds: ["trip-a"] },
    heroByTripId: { "trip-a": { url: "https://img.example.test/a.jpg", focal: { x: 0.25, y: 0.75 }, zoom: 1.4 } },
    titleOverrides: { "trip-a": "Миний нэр" },
  }, "boss@example.test");
  assert.deepEqual(saved.heroByTripId["trip-a"], { url: "https://img.example.test/a.jpg", focal: { x: 0.25, y: 0.75 }, zoom: 1.4 });
  const loaded = await S.getCatalogueConfig();
  assert.deepEqual(loaded.heroByTripId, saved.heroByTripId);
  assert.equal(loaded.titleOverrides["trip-a"], "Миний нэр");
  assert.deepEqual(loaded.quick.tripIds, ["trip-a"]);
});

test("config: empty before the first save, then round-trips with actor and time, and audits", async () => {
  assert.deepEqual(await S.getCatalogueConfig(), S.defaultCatalogueConfig());
  const saved = await S.saveCatalogueConfig({ quick: { tripIds: ["trip-a", "trip-b"], featuredTripIds: ["trip-a"] } }, "boss@example.test");
  assert.equal(saved.updatedBy, "boss@example.test");
  assert.equal(saved.updatedAt, new Date(nowMs).toISOString());
  const loaded = await S.getCatalogueConfig();
  assert.deepEqual(loaded, saved);
  assert.ok(db.audit.some((row) => row.action === "config_save" && row.actor === "boss@example.test"));
  await assert.rejects(S.saveCatalogueConfig(null, "x"), (e: any) => e.code === "invalid_input");
});

test("config: a stale editor cannot overwrite a newer save", async () => {
  const first = await S.saveCatalogueConfig({ quick: { tripIds: ["a"] } }, "one@example.test", { expectedUpdatedAt: null });
  advance(5000);
  await S.saveCatalogueConfig({ quick: { tripIds: ["a", "b"] } }, "two@example.test", { expectedUpdatedAt: first.updatedAt });
  await assert.rejects(
    S.saveCatalogueConfig({ quick: { tripIds: ["z"] } }, "one@example.test", { expectedUpdatedAt: first.updatedAt }),
    (e: any) => e.code === "config_conflict",
  );
  assert.deepEqual((await S.getCatalogueConfig()).quick.tripIds, ["a", "b"]);
});

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

test("versions: file names per edition, monotonic numbers per edition, drafts first", async () => {
  const q1 = await draft("quick");
  const q2 = await draft("quick");
  const c1 = await draft("complete");
  const p1 = await draft("preview");
  assert.equal(q1.fileName, "UUDAM_Corporate_2026-11-06_v1.pdf");
  assert.equal(q2.fileName, "UUDAM_Corporate_2026-11-06_v2.pdf");
  assert.equal(c1.fileName, "UUDAM_Complete_2026-11-06_v1.pdf");
  assert.equal(p1.fileName, "UUDAM_Preview_2026-11-06_v1.pdf");
  for (const meta of [q1, q2, c1, p1]) {
    assert.equal(meta.status, "draft");
    assert.equal(meta.publishedAt, null);
    assert.equal(meta.pageCount, 2);
    assert.equal(meta.tripCount, 2);
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    assert.match(meta.publicToken, /^[A-Za-z0-9_-]{24,64}$/);
  }
  assert.equal(q1.generatedBy, "staff@example.test");
  assert.equal(q1.contentHash, "hash-quick");
  assert.equal((await S.listVersions("quick")).map((v) => v.versionNo).join(), "2,1");
  assert.equal((await S.listVersions()).length, 4);
  assert.deepEqual(await S.listVersions("nonsense" as any), []);
});

test("versions: stored bytes, hash, page images and snapshot come back exactly", async () => {
  const meta = await draft("quick", [noteOnly], 200);
  const file = await S.getVersionPdf(meta.id);
  assert.ok(file);
  assert.ok(file.bytes.equals(pdfBytes(200)));
  assert.equal(file.meta.sizeBytes, pdfBytes(200).length);
  const { createHash } = await import("node:crypto");
  assert.equal(file.meta.sha256, createHash("sha256").update(pdfBytes(200)).digest("hex"));
  assert.ok((await S.getVersionPageImage(meta.id, 2))?.equals(Buffer.from([0xff, 0xd8, 2])));
  assert.equal(await S.getVersionPageImage(meta.id, 3), null);
  assert.equal(await S.getVersionPageImage(meta.id, 0), null);
  assert.equal((await S.getVersionSnapshot(meta.id))?.trips[0].title, "Тест-Далай");
  assert.deepEqual((await S.getVersionMeta(meta.id))?.warnings, [noteOnly]);
  assert.equal(await S.getVersionMeta("not-a-uuid"), null);
  assert.equal(await S.getVersionPdf("00000000-0000-4000-8000-0000000fffff"), null);
});

test("versions: listing and meta reads never select the heavy columns", async () => {
  const meta = await draft("quick");
  await S.listVersions("quick");
  await S.listVersions();
  await S.getVersionMeta(meta.id);
  await S.getPublished("quick");
  await S.getPublicFileMetaByToken(meta.publicToken);
  for (const tag of ["versions_list_edition", "versions_list_all", "version_meta", "published_get", "public_meta"]) {
    assert.ok(db.sqlByTag[tag], tag);
    assert.ok(!/bytes|snapshot/.test(db.sqlByTag[tag]), `${tag} must not select bytes or snapshot`);
  }
  const list = await S.listVersions("quick");
  assert.ok(!("bytes" in list[0]) && !("snapshot" in list[0]));
});

test("versions: warnings from the snapshot and the renderer are merged without duplicates", async () => {
  advance(1000);
  const meta = await S.saveDraftVersion({
    edition: "quick", snapshot: snapshot("quick", [noteOnly, blocking]), rendered: rendered(64, [noteOnly, { ...noteOnly, message: "Өөр" }]), actor: "a@example.test",
  });
  assert.equal(meta.warnings.length, 3);
});

test("versions: refuses a non-PDF, an over-limit PDF, a snapshot of the wrong edition, an unknown edition", async () => {
  const base = { edition: "quick" as const, snapshot: snapshot("quick"), actor: "a" };
  await assert.rejects(S.saveDraftVersion({ ...base, rendered: { ...rendered(), pdf: Buffer.from("<html>nope</html> and more") } }), (e: any) => e.code === "invalid_pdf");
  await assert.rejects(S.saveDraftVersion({ ...base, rendered: { ...rendered(), pdf: Buffer.alloc(0) } }), (e: any) => e.code === "invalid_pdf");
  const huge = Buffer.alloc(S.CATALOGUE_MAX_PDF_BYTES + 1);
  huge.write("%PDF-1.7\n");
  await assert.rejects(S.saveDraftVersion({ ...base, rendered: { ...rendered(), pdf: huge } }), (e: any) => e.code === "pdf_too_large");
  await assert.rejects(S.saveDraftVersion({ ...base, edition: "complete", rendered: rendered() }), (e: any) => e.code === "invalid_input");
  await assert.rejects(S.saveDraftVersion({ ...base, edition: "bogus" as any, rendered: rendered() }), (e: any) => e.code === "invalid_input");
  assert.equal(db.versions.length, 0, "nothing half-saved");
});

test("versions: a failed page insert rolls the whole draft back", async () => {
  db.failures.push({ tag: "page_insert", error: new Error("page write failed"), times: 1 });
  await assert.rejects(S.saveDraftVersion({ edition: "quick", snapshot: snapshot(), rendered: rendered(), actor: "a" }), /page write failed/);
  assert.equal(db.versions.length, 0);
  assert.equal(db.pages.length, 0);
  assert.equal(db.audit.length, 0);
  const retry = await S.saveDraftVersion({ edition: "quick", snapshot: snapshot(), rendered: rendered(), actor: "a" });
  assert.equal(retry.versionNo, 1, "the failed attempt did not burn a version number");
});

test("versions: concurrent drafts of one edition get distinct, gapless numbers", async () => {
  const metas = await Promise.all(Array.from({ length: 6 }, () => S.saveDraftVersion({ edition: "quick", snapshot: snapshot(), rendered: rendered(), actor: "a" })));
  assert.deepEqual(metas.map((m) => m.versionNo).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(metas.map((m) => m.publicToken)).size, 6);
});

test("versions: draft -> publish -> publish newer -> rollback, one published at every step", async () => {
  const v1 = await draft("quick");
  const v2 = await draft("quick");
  assert.equal(await S.getPublished("quick"), null);

  advance(1000);
  const p1 = await S.publishVersion(v1.id, "boss@example.test");
  assert.equal(p1.status, "published");
  assert.equal(p1.publishedBy, "boss@example.test");
  assert.equal(p1.publishedAt, new Date(nowMs).toISOString());
  assert.equal((await S.getPublished("quick"))?.id, v1.id);

  advance(1000);
  await S.publishVersion(v2.id, "boss@example.test");
  assert.equal((await S.getPublished("quick"))?.id, v2.id);
  let statuses = (await S.listVersions("quick")).map((v) => `${v.versionNo}:${v.status}`);
  assert.deepEqual(statuses, ["2:published", "1:superseded"]);

  advance(1000);
  const back = await S.rollbackTo(v1.id, "boss@example.test");
  assert.equal(back.status, "published");
  assert.equal((await S.getPublished("quick"))?.id, v1.id);
  statuses = (await S.listVersions("quick")).map((v) => `${v.versionNo}:${v.status}`);
  assert.deepEqual(statuses, ["2:superseded", "1:published"]);

  const actions = db.audit.map((row) => row.action);
  assert.deepEqual(actions.filter((a) => a !== "generate"), ["publish", "publish", "rollback"]);
  const rollbackAudit = db.audit.find((row) => row.action === "rollback")!;
  assert.equal(rollbackAudit.version_id, v1.id);
  assert.equal(rollbackAudit.detail.supersededVersionId, v2.id);
});

test("versions: editions are independent pointers", async () => {
  const q = await draft("quick");
  const c = await draft("complete");
  await S.publishVersion(q.id, "a");
  await S.publishVersion(c.id, "a");
  assert.equal((await S.getPublished("quick"))?.id, q.id);
  assert.equal((await S.getPublished("complete"))?.id, c.id);
  assert.equal(await S.getPublished("preview"), null);
});

test("versions: blocking warnings stop a publish unless acknowledged; the old pointer survives a refusal", async () => {
  const good = await draft("quick");
  await S.publishVersion(good.id, "boss");
  const risky = await draft("quick", [noteOnly, blocking]);
  await assert.rejects(S.publishVersion(risky.id, "boss"), (e: any) => {
    assert.equal(e.code, "blocking_warnings");
    assert.deepEqual(e.detail.warnings, [blocking], "the caller can show exactly what blocks");
    return true;
  });
  assert.equal((await S.getPublished("quick"))?.id, good.id, "refusal changes nothing");
  assert.equal((await S.getVersionMeta(risky.id))?.status, "draft");
  const done = await S.publishVersion(risky.id, "boss", { acknowledgeWarnings: true });
  assert.equal(done.status, "published");
  assert.equal(db.audit.find((r) => r.action === "publish" && r.version_id === risky.id)!.detail.acknowledgedBlockingWarnings, 1);
  assert.equal((await S.getVersionMeta(good.id))?.status, "superseded");
  // non-blocking warnings never gate
  const mild = await draft("quick", [noteOnly]);
  assert.equal((await S.publishVersion(mild.id, "boss")).status, "published");
});

test("versions: publish is idempotent, unknown ids and the preview sample are refused", async () => {
  const v = await draft("quick");
  const first = await S.publishVersion(v.id, "boss");
  advance(5000);
  const again = await S.publishVersion(v.id, "someone-else");
  assert.equal(again.publishedAt, first.publishedAt, "a double click changes nothing");
  assert.equal(db.audit.filter((r) => r.action === "publish").length, 1);
  await assert.rejects(S.publishVersion("00000000-0000-4000-8000-0000000fffff", "a"), (e: any) => e.code === "version_not_found");
  await assert.rejects(S.publishVersion("garbage", "a"), (e: any) => e.code === "version_not_found");
  const preview = await draft("preview");
  await assert.rejects(S.publishVersion(preview.id, "a"), (e: any) => e.code === "preview_not_publishable");
});

test("versions: rollback only accepts a version that was published before", async () => {
  const v1 = await draft("quick");
  const v2 = await draft("quick");
  await S.publishVersion(v1.id, "a");
  await assert.rejects(S.rollbackTo(v2.id, "a"), (e: any) => e.code === "rollback_requires_previous_version");
  assert.equal((await S.rollbackTo(v1.id, "a")).id, v1.id, "already live: nothing to do");
  await assert.rejects(S.rollbackTo("00000000-0000-4000-8000-0000000fffff", "a"), (e: any) => e.code === "version_not_found");
  // rollback does not re-ask about blocking warnings the version carried when it was published
  const risky = await draft("quick", [blocking]);
  await S.publishVersion(risky.id, "a", { acknowledgeWarnings: true });
  await S.publishVersion(v2.id, "a");
  assert.equal((await S.rollbackTo(risky.id, "a")).status, "published");
});

test("versions: two admins publishing at once leave exactly one published row", async () => {
  const a = await draft("quick");
  const b = await draft("quick");
  const c = await draft("quick");
  await Promise.all([S.publishVersion(a.id, "x"), S.publishVersion(b.id, "y"), S.publishVersion(c.id, "z")]);
  const published = (await S.listVersions("quick")).filter((v) => v.status === "published");
  assert.equal(published.length, 1);
  assert.equal((await S.listVersions("quick")).filter((v) => v.status === "superseded").length, 2);
});

test("versions: a failed activation rolls back and keeps the previous published version", async () => {
  const a = await draft("quick");
  const b = await draft("quick");
  await S.publishVersion(a.id, "x");
  db.failures.push({ tag: "publish_activate", error: new Error("connection lost"), times: 1 });
  await assert.rejects(S.publishVersion(b.id, "x"), /connection lost/);
  assert.equal((await S.getPublished("quick"))?.id, a.id, "supersede was undone with the rest of the transaction");
  assert.equal((await S.getVersionMeta(b.id))?.status, "draft");
});

test("versions: public lookup serves published and superseded files, never drafts or unknown tokens", async () => {
  const v1 = await draft("quick");
  const v2 = await draft("quick");
  assert.equal(await S.getPublicFileByToken(v1.publicToken), null, "draft is not public");
  await S.publishVersion(v1.id, "a");
  assert.ok((await S.getPublicFileByToken(v1.publicToken))?.bytes.equals(pdfBytes()));
  await S.publishVersion(v2.id, "a");
  assert.equal((await S.getPublicFileByToken(v1.publicToken))?.meta.status, "superseded", "an old link keeps working");
  assert.equal(await S.getPublicFileByToken(v2.publicToken).then((f) => f?.meta.status), "published");
  assert.equal(await S.getPublicFileByToken("T" + "9".repeat(31)), null);
  assert.equal(await S.getPublicFileByToken("short"), null);
  assert.equal(await S.getPublicFileByToken("../../etc/passwd"), null);
  assert.equal(await S.getPublicFileByToken(v1.id), null, "the internal id is not a token");
});

// ---------------------------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------------------------

test("prune: keeps the newest N per edition and never deletes a published row", async () => {
  const quick: Awaited<ReturnType<typeof draft>>[] = [];
  for (let i = 0; i < 6; i++) quick.push(await draft("quick"));
  const complete: Awaited<ReturnType<typeof draft>>[] = [];
  for (let i = 0; i < 3; i++) complete.push(await draft("complete"));
  await S.publishVersion(quick[0].id, "a"); // the OLDEST version is the live one
  await S.cacheFbAttachment(quick[1].id, "page-1", "att-old");
  const result = await S.pruneOldVersions(2);
  assert.equal(result.deleted, 4, "3 old quick drafts + 1 old complete; the old PUBLISHED quick row stays");
  const left = (await S.listVersions("quick")).map((v) => `${v.versionNo}:${v.status}`);
  assert.deepEqual(left, ["6:draft", "5:draft", "1:published"]);
  assert.equal((await S.listVersions("complete")).length, 2);
  assert.equal((await S.getPublished("quick"))?.id, quick[0].id);
  assert.equal(db.pages.filter((p) => p.version_id === quick[1].id).length, 0, "page images go with the version");
  assert.equal(await S.getCachedFbAttachment(quick[1].id, "page-1"), null, "so do cached attachment ids");
  assert.ok(db.audit.some((r) => r.action === "prune" && r.detail.deleted === 4));
});

test("prune: default keeps 20, never goes below 1, and does nothing when there is nothing to remove", async () => {
  for (let i = 0; i < 3; i++) await draft("quick");
  assert.deepEqual(await S.pruneOldVersions(), { deleted: 0 });
  assert.equal(db.audit.filter((r) => r.action === "prune").length, 0);
  assert.deepEqual(await S.pruneOldVersions(0), { deleted: 0 }, "an unusable number falls back to the default");
  const result = await S.pruneOldVersions(-5);
  assert.equal(result.deleted, 2, "never keeps fewer than one");
  assert.equal((await S.listVersions("quick"))[0].versionNo, 3);
  // numbering continues after a prune, a deleted number is never handed out again
  assert.equal((await draft("quick")).versionNo, 4);
});

// ---------------------------------------------------------------------------------------------
// Public file route
// ---------------------------------------------------------------------------------------------

function makeRes() {
  const res: any = {
    statusCode: 200, headers: {} as Record<string, string>, chunks: [] as Buffer[], ended: false, headersSent: false,
    setHeader(name: string, value: unknown) {
      this.headers[name.toLowerCase()] = String(value);
    },
    write(chunk: Buffer) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
      this.headersSent = true;
    },
  };
  Object.defineProperty(res, "body", { get: () => Buffer.concat(res.chunks) });
  return res;
}

/** `ip` is the caller's address: the socket address, and the forwarded header when the platform is trusted. */
async function call(token: string | string[] | undefined, init: { method?: string; headers?: Record<string, string>; ip?: string } = {}) {
  const res = makeRes();
  const ip = init.ip ?? "198.51.100.10";
  const headers = { "x-forwarded-for": ip, ...(init.headers ?? {}) };
  await ROUTE.default({ method: init.method ?? "GET", query: { token }, headers, socket: { remoteAddress: ip } } as any, res);
  return res;
}

test("route: a published file is served as an inline PDF with every required header", async () => {
  const meta = await draft("quick", [], 3000);
  await S.publishVersion(meta.id, "boss");
  const res = await call(meta.publicToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.equal(res.headers["content-length"], String(pdfBytes(3000).length));
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["etag"], `"${meta.sha256}"`);
  assert.match(res.headers["cache-control"], /^public, max-age=3600, s-maxage=3600, immutable$/);
  assert.equal(res.headers["accept-ranges"], "bytes");
  assert.match(res.headers["x-robots-tag"], /noindex/);
  assert.equal(res.headers["content-disposition"], `inline; filename="UUDAM_Corporate_2026-11-06_v1.pdf"; filename*=UTF-8''UUDAM_Corporate_2026-11-06_v1.pdf`);
  assert.ok(res.body.equals(pdfBytes(3000)));
});

test("route: the content disposition carries an ASCII name and an RFC 5987 UTF-8 name", async () => {
  const meta = await draft("quick");
  await S.publishVersion(meta.id, "boss");
  db.versions[0].file_name = "Каталог (2026) v1.pdf";
  const res = await call(meta.publicToken);
  assert.equal(
    res.headers["content-disposition"],
    `inline; filename="_2026_v1.pdf"; filename*=UTF-8''${encodeURIComponent("Каталог")}%20%282026%29%20v1.pdf`,
  );
  assert.ok(!/[^ -~]/.test(res.headers["content-disposition"]), "header is pure ASCII");
});

test("route: HEAD returns the same headers and no body", async () => {
  const meta = await draft("quick", [], 500);
  await S.publishVersion(meta.id, "boss");
  const res = await call(meta.publicToken, { method: "HEAD" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.equal(res.headers["content-length"], String(pdfBytes(500).length));
  assert.equal(res.body.length, 0);
  assert.ok(!db.queries.includes("public_file"), "HEAD never reads the PDF bytes");
});

test("route: unknown, malformed and draft tokens all answer the same 404, and nothing lists", async () => {
  const meta = await draft("quick");
  const results = await Promise.all([
    call("T" + "8".repeat(31)), call("short"), call("../../etc/passwd"), call(undefined), call(["a", "b"]), call(meta.publicToken), call(meta.id),
  ]);
  for (const res of results) {
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.toString(), "Not found");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(!res.headers["content-disposition"] && res.headers["content-type"] !== "application/pdf");
  }
  const head = await call("T" + "8".repeat(31), { method: "HEAD" });
  assert.equal(head.statusCode, 404);
  assert.equal(head.body.length, 0);
});

test("route: malformed tokens never reach the database", async () => {
  db.queries.length = 0;
  await call("x".repeat(500));
  await call("has space in it 123456789012345");
  assert.deepEqual(db.queries, []);
});

test("route: a draft becomes reachable only once published, and stays reachable when superseded", async () => {
  const v1 = await draft("quick");
  const v2 = await draft("quick");
  assert.equal((await call(v1.publicToken)).statusCode, 404);
  await S.publishVersion(v1.id, "a");
  assert.equal((await call(v1.publicToken)).statusCode, 200);
  await S.publishVersion(v2.id, "a");
  assert.equal((await call(v1.publicToken)).statusCode, 200, "superseded: old links keep working");
  assert.equal((await call(v2.publicToken)).statusCode, 200);
  await S.pruneOldVersions(1);
  assert.equal((await call(v1.publicToken)).statusCode, 404, "pruned: gone");
});

test("route: only GET and HEAD", async () => {
  const meta = await draft("quick");
  await S.publishVersion(meta.id, "a");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await call(meta.publicToken, { method });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers["allow"], "GET, HEAD");
  }
});

test("route: conditional requests answer 304 without reading the bytes", async () => {
  const meta = await draft("quick");
  await S.publishVersion(meta.id, "a");
  db.queries.length = 0;
  for (const header of [`"${meta.sha256}"`, `W/"${meta.sha256}"`, `"zzz", "${meta.sha256}"`, "*"]) {
    const res = await call(meta.publicToken, { headers: { "if-none-match": header } });
    assert.equal(res.statusCode, 304, header);
    assert.equal(res.body.length, 0);
    assert.equal(res.headers["etag"], `"${meta.sha256}"`);
  }
  assert.ok(!db.queries.includes("public_file"));
  assert.equal((await call(meta.publicToken, { headers: { "if-none-match": '"other"' } })).statusCode, 200);
});

test("route: byte ranges are served, bad ranges are 416, junk ranges fall back to the whole file", async () => {
  const meta = await draft("quick", [], 1000);
  await S.publishVersion(meta.id, "a");
  const whole = pdfBytes(1000);
  const part = await call(meta.publicToken, { headers: { range: "bytes=10-19" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 10-19/${whole.length}`);
  assert.equal(part.headers["content-length"], "10");
  assert.ok(part.body.equals(whole.subarray(10, 20)));
  const tail = await call(meta.publicToken, { headers: { range: "bytes=-5" } });
  assert.ok(tail.body.equals(whole.subarray(whole.length - 5)));
  const open = await call(meta.publicToken, { headers: { range: "bytes=100-" } });
  assert.ok(open.body.equals(whole.subarray(100)));
  const past = await call(meta.publicToken, { headers: { range: `bytes=${whole.length + 5}-` } });
  assert.equal(past.statusCode, 416);
  assert.equal(past.headers["content-range"], `bytes */${whole.length}`);
  const junk = await call(meta.publicToken, { headers: { range: "bytes=0-1,5-6" } });
  assert.equal(junk.statusCode, 200);
  assert.ok(junk.body.equals(whole));
});

test("route: a large PDF is streamed in chunks and arrives intact", async () => {
  const meta = await draft("quick", [], 2_500_000);
  await S.publishVersion(meta.id, "a");
  const res = await call(meta.publicToken);
  assert.equal(res.statusCode, 200);
  assert.ok(res.chunks.length > 2, "written in chunks");
  assert.ok(res.body.equals(pdfBytes(2_500_000)));
});

test("route: a database failure is a 503 that leaks nothing", async () => {
  const meta = await draft("quick");
  await S.publishVersion(meta.id, "a");
  db.failures.push({ tag: "public_meta", error: new Error("password authentication failed for user neondb_owner"), times: 1 });
  const res = await call(meta.publicToken);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "30");
  assert.ok(!res.body.toString().includes("neondb_owner"));
});

test("route: every successful answer is CDN-cacheable (s-maxage), every refusal is not", async () => {
  const meta = await draft("quick", [], 2100);
  await S.publishVersion(meta.id, "boss");
  const cdn = /^public, max-age=3600, s-maxage=3600, immutable$/;
  const whole = await call(meta.publicToken);
  assert.equal(whole.statusCode, 200);
  assert.match(whole.headers["cache-control"], cdn);
  assert.match((await call(meta.publicToken, { method: "HEAD" })).headers["cache-control"], cdn);
  const part = await call(meta.publicToken, { headers: { range: "bytes=0-9" } });
  assert.equal(part.statusCode, 206);
  assert.match(part.headers["cache-control"], cdn);
  const notModified = await call(meta.publicToken, { headers: { "if-none-match": `"${meta.sha256}"` } });
  assert.equal(notModified.statusCode, 304);
  assert.match(notModified.headers["cache-control"], cdn);
  assert.equal((await call("T" + "8".repeat(31))).headers["cache-control"], "no-store");
});

test("route: a client that hammers the link gets 429 before any database read; other clients are unaffected", async () => {
  const meta = await draft("quick", [], 1500);
  await S.publishVersion(meta.id, "boss");
  const abuser = "203.0.113.50";
  for (let i = 1; i <= 30; i++) {
    assert.equal((await call(meta.publicToken, { ip: abuser, method: "HEAD" })).statusCode, 200, `request ${i} is within the budget`);
  }
  db.queries.length = 0;
  const blocked = await call(meta.publicToken, { ip: abuser });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.toString(), "Too many requests");
  assert.equal(blocked.headers["cache-control"], "no-store");
  assert.ok(Number(blocked.headers["retry-after"]) >= 1 && Number(blocked.headers["retry-after"]) <= 60, blocked.headers["retry-after"]);
  assert.notEqual(blocked.headers["content-type"], "application/pdf");
  assert.deepEqual(db.queries, [], "refused before the metadata or the bytes are read");
  const ranged = await call(meta.publicToken, { ip: abuser, headers: { range: "bytes=0-9" } });
  assert.equal(ranged.statusCode, 429, "Range bursts are limited like everything else");
  const head = await call(meta.publicToken, { ip: abuser, method: "HEAD" });
  assert.equal(head.statusCode, 429);
  assert.equal(head.body.length, 0);
  assert.deepEqual(db.queries, []);
  const other = await call(meta.publicToken, { ip: "203.0.113.51" });
  assert.equal(other.statusCode, 200, "another IP has its own budget");
  assert.ok(other.body.equals(pdfBytes(1500)));
});

test("route: a PDF viewer's burst of Range requests reads the bytes from the database once", async () => {
  const meta = await draft("quick", [], 8123);
  await S.publishVersion(meta.id, "boss");
  const whole = pdfBytes(8123);
  db.queries.length = 0;
  for (let i = 0; i < 6; i++) {
    const part = await call(meta.publicToken, { headers: { range: `bytes=${i * 100}-${i * 100 + 99}` } });
    assert.equal(part.statusCode, 206);
    assert.ok(part.body.equals(whole.subarray(i * 100, i * 100 + 100)), `range ${i}`);
  }
  assert.equal(db.queries.filter((q) => q === "public_file").length, 1, "one BYTEA read for six Range requests");
  assert.equal(db.queries.filter((q) => q === "public_meta").length, 6, "the token is still re-checked every time");
});

// ---------------------------------------------------------------------------------------------
// Send claims
// ---------------------------------------------------------------------------------------------

const claimInput = (over: Partial<Parameters<typeof S.claimSend>[0]> = {}) => ({
  senderId: "psid-1111111111", edition: "quick" as const, versionId: "00000000-0000-4000-8000-00000000abcd", explicitResend: false, ...over,
});

test("claims: the first claim wins, a redelivery of the same message is a duplicate", async () => {
  const first = await S.claimSend(claimInput({ dedupeKey: "mid.A" }));
  assert.equal(first.claimed, true);
  assert.match(first.sendId, /^[0-9a-f-]{36}$/);
  const redelivery = await S.claimSend(claimInput({ dedupeKey: "mid.A" }));
  assert.deepEqual([redelivery.claimed, redelivery.reason, redelivery.sendId], [false, "duplicate_message", first.sendId]);
  const explicitRedelivery = await S.claimSend(claimInput({ dedupeKey: "mid.A", explicitResend: true }));
  assert.equal(explicitRedelivery.claimed, false, "even an explicit resend message cannot be delivered twice");
  assert.equal(db.sends.length, 1);
  assert.equal(db.sends[0].suppressed_count, 2);
});

test("claims: without a message id, repeat requests inside the window are suppressed (in flight, then recent)", async () => {
  const first = await S.claimSend(claimInput());
  const inFlight = await S.claimSend(claimInput());
  assert.deepEqual([inFlight.claimed, inFlight.reason], [false, "in_flight"]);
  await S.finishSend(first.sendId, { status: "sent", metaMessageId: "m_1" });
  advance(30 * 60_000);
  const recent = await S.claimSend(claimInput());
  assert.deepEqual([recent.claimed, recent.reason], [false, "recent_send"]);
  assert.equal(db.sends.length, 1);
});

test("claims: the window expires (default 6 h, or the caller's)", async () => {
  const first = await S.claimSend(claimInput());
  await S.finishSend(first.sendId, { status: "sent" });
  advance(6 * HOUR - 1);
  assert.equal((await S.claimSend(claimInput())).claimed, false);
  advance(2);
  const again = await S.claimSend(claimInput());
  assert.equal(again.claimed, true, "6 h passed");
  await S.finishSend(again.sendId, { status: "sent" });
  advance(2 * HOUR);
  assert.equal((await S.claimSend(claimInput({ windowMs: 3 * HOUR }))).claimed, false);
  advance(2 * HOUR);
  assert.equal((await S.claimSend(claimInput({ windowMs: 3 * HOUR }))).claimed, true, "custom 3 h window");
});

test("claims: an explicit resend is allowed after a short burst guard, not instantly", async () => {
  const first = await S.claimSend(claimInput());
  await S.finishSend(first.sendId, { status: "sent" });
  const instant = await S.claimSend(claimInput({ explicitResend: true }));
  assert.deepEqual([instant.claimed, instant.reason], [false, "burst_guard"]);
  advance(S.EXPLICIT_RESEND_BURST_MS + 1);
  const resend = await S.claimSend(claimInput({ explicitResend: true }));
  assert.equal(resend.claimed, true);
  assert.equal(db.sends.find((row) => row.id === resend.sendId)!.explicit_resend, true);
  assert.equal(db.sends.length, 2);
});

test("claims: failed, blocked and empty outcomes never block the next claim", async () => {
  const statuses = ["failed", "blocked_staff_owned", "blocked_paused", "blocked_window", "blocked_killswitch", "no_published_version", "dry_run"] as const;
  for (const status of statuses) {
    const claim = await S.claimSend(claimInput());
    assert.equal(claim.claimed, true, `after ${status}`);
    await S.finishSend(claim.sendId, { status, reason: status });
  }
  const fallback = await S.claimSend(claimInput());
  await S.finishSend(fallback.sendId, { status: "stale_fallback" });
  assert.equal((await S.claimSend(claimInput())).claimed, false, "a link-only fallback was still a delivery");
});

test("claims: a stale notice blocks only its own version; a freshly published version is claimed at once", async () => {
  const OLD = "00000000-0000-4000-8000-00000000abcd";
  const NEW = "00000000-0000-4000-8000-00000000abce";
  const NEWER = "00000000-0000-4000-8000-00000000abcf";
  const stale = await S.claimSend(claimInput({ versionId: OLD, dedupeKey: "mid.S1" }));
  await S.finishSend(stale.sendId, { status: "stale_fallback", reason: "stale:age" });
  advance(10 * 60_000);
  const again = await S.claimSend(claimInput({ versionId: OLD, dedupeKey: "mid.S2" }));
  assert.deepEqual([again.claimed, again.reason, again.priorStatus], [false, "recent_send", "stale_fallback"], "the same stale version: the notice already went");
  // The same inbound message is still one send, whatever was published meanwhile.
  const redelivery = await S.claimSend(claimInput({ versionId: NEW, dedupeKey: "mid.S1" }));
  assert.deepEqual([redelivery.claimed, redelivery.reason], [false, "duplicate_message"]);
  // Staff published a fresh version: the customer who was told to wait gets it.
  const fresh = await S.claimSend(claimInput({ versionId: NEW, dedupeKey: "mid.S3" }));
  assert.equal(fresh.claimed, true, "a stale_fallback row must not block a freshly published version");
  await S.finishSend(fresh.sendId, { status: "sent" });
  // A delivered file does block, whichever version comes next: the customer already has a catalogue.
  const next = await S.claimSend(claimInput({ versionId: NEWER, dedupeKey: "mid.S4" }));
  assert.deepEqual([next.claimed, next.reason, next.priorStatus], [false, "recent_send", "sent"]);
});

test("claims: a refused claim says what refused it and how long ago, so a double tap can be told from a second ask", async () => {
  const first = await S.claimSend(claimInput({ dedupeKey: "mid.P1" }));
  const inFlight = await S.claimSend(claimInput({ dedupeKey: "mid.P2" }));
  assert.deepEqual([inFlight.reason, inFlight.priorStatus, inFlight.priorAgeMs], ["in_flight", "claimed", 0]);
  await S.finishSend(first.sendId, { status: "sent" });
  advance(20_000);
  const tap = await S.claimSend(claimInput({ dedupeKey: "mid.P3" }));
  assert.deepEqual([tap.reason, tap.priorStatus, tap.priorAgeMs], ["recent_send", "sent", 20_000]);
  advance(10 * 60_000);
  const later = await S.claimSend(claimInput({ dedupeKey: "mid.P4" }));
  assert.deepEqual([later.reason, later.priorStatus, later.priorAgeMs], ["recent_send", "sent", 20_000 + 10 * 60_000]);
  assert.equal(db.sends.length, 1, "refusals take no send slot");
});

test("claims: an abandoned in-flight claim stops blocking after five minutes", async () => {
  const first = await S.claimSend(claimInput());
  advance(S.CLAIM_IN_FLIGHT_MS - 1000);
  assert.equal((await S.claimSend(claimInput())).claimed, false);
  advance(2000);
  const retry = await S.claimSend(claimInput());
  assert.equal(retry.claimed, true);
  assert.notEqual(retry.sendId, first.sendId);
});

test("claims: a failed message is retried by Meta's redelivery, unless something else was delivered meanwhile", async () => {
  const first = await S.claimSend(claimInput({ dedupeKey: "mid.F" }));
  await S.finishSend(first.sendId, { status: "failed", reason: "meta_timeout", retries: 2 });
  const retry = await S.claimSend(claimInput({ dedupeKey: "mid.F" }));
  assert.deepEqual([retry.claimed, retry.sendId], [true, first.sendId], "same row reopened");
  assert.equal(db.sends.length, 1);
  assert.equal(db.sends[0].status, "claimed");
  assert.equal(db.sends[0].reason, null);
  await S.finishSend(retry.sendId, { status: "failed", reason: "again" });

  const other = await S.claimSend(claimInput({ dedupeKey: "mid.G" }));
  await S.finishSend(other.sendId, { status: "sent" });
  const late = await S.claimSend(claimInput({ dedupeKey: "mid.F" }));
  assert.deepEqual([late.claimed, late.reason], [false, "recent_send"], "the customer already has the file");
});

test("claims: different senders and editions never block each other", async () => {
  const a = await S.claimSend(claimInput({ senderId: "psid-A" }));
  const b = await S.claimSend(claimInput({ senderId: "psid-B" }));
  const c = await S.claimSend(claimInput({ senderId: "psid-A", edition: "complete" }));
  assert.deepEqual([a.claimed, b.claimed, c.claimed], [true, true, true]);
});

test("claims: ten simultaneous webhook deliveries create exactly one send", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => S.claimSend(claimInput())));
  assert.equal(results.filter((r) => r.claimed).length, 1);
  assert.equal(db.sends.length, 1);
  assert.equal(new Set(results.filter((r) => !r.claimed).map((r) => r.sendId)).size, 1, "all point at the winner");
  assert.equal(db.sends[0].suppressed_count, 9);
});

test("claims: ten simultaneous deliveries of the same message id, explicit or not, create exactly one send", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => S.claimSend(claimInput({ dedupeKey: "mid.same", explicitResend: i % 2 === 0 }))));
  assert.equal(results.filter((r) => r.claimed).length, 1);
  assert.equal(db.sends.length, 1);
});

test("claims: the advisory lock is what serialises claims; without it the dedupe index still stops a double send of one message", async () => {
  db.honorLocks = false;
  const unlocked = await Promise.all(Array.from({ length: 6 }, () => S.claimSend(claimInput({ senderId: "psid-race" }))));
  assert.ok(unlocked.filter((r) => r.claimed).length > 1, "proves the harness would catch a missing lock");

  db.sends.length = 0;
  const settled = await Promise.allSettled(Array.from({ length: 6 }, () => S.claimSend(claimInput({ senderId: "psid-race2", dedupeKey: "mid.race" }))));
  assert.equal(db.sends.length, 1, "unique (sender, message) index: one row at most");
  assert.equal(settled.filter((r) => r.status === "fulfilled" && r.value.claimed).length, 1, "and one winner; a loser errors instead of sending");
});

test("claims: the raw sender id and message id are never stored", async () => {
  const claim = await S.claimSend(claimInput({ senderId: "psid-9988776655", dedupeKey: "mid.secret-message-id" }));
  await S.finishSend(claim.sendId, { status: "failed", reason: "Meta said (#100) recipient 9988776655443322 unreachable" });
  const dump = JSON.stringify(db.sends);
  assert.ok(!dump.includes("9988776655"), "no raw sender id, no long digit run in the reason");
  assert.ok(!dump.includes("secret-message-id"));
  assert.equal(db.sends[0].sender_hash, S.hashCatalogueSender("psid-9988776655"));
  assert.match(db.sends[0].sender_hash, /^[0-9a-f]{16}$/);
  assert.match(db.sends[0].reason, /recipient # unreachable/);
});

test("claims: input is validated", async () => {
  await assert.rejects(S.claimSend(claimInput({ senderId: "  " })), (e: any) => e.code === "invalid_input");
  await assert.rejects(S.claimSend(claimInput({ edition: "bogus" as any })), (e: any) => e.code === "invalid_input");
  const odd = await S.claimSend(claimInput({ versionId: "not-a-uuid", windowMs: Number.NaN }));
  assert.equal(odd.claimed, true);
  assert.equal(db.sends[0].version_id, null);
});

test("finishSend: records outcome, retries and message id; unknown ids and bad statuses are handled", async () => {
  const claim = await S.claimSend(claimInput());
  advance(2000);
  assert.equal(await S.finishSend(claim.sendId, { status: "sent", metaMessageId: " m_abc ", reason: null, retries: 2 }), true);
  const row = db.sends[0];
  assert.deepEqual([row.status, row.meta_message_id, row.retries, row.reason, row.finished_at], ["sent", "m_abc", 2, null, new Date(nowMs).toISOString()]);
  assert.equal(await S.finishSend("00000000-0000-4000-8000-0000000fffff", { status: "sent" }), false);
  assert.equal(await S.finishSend("nope", { status: "sent" }), false);
  await assert.rejects(S.finishSend(claim.sendId, { status: "delivered" as any }), (e: any) => e.code === "invalid_input");
});

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

test("stats: aggregates by status, edition, version and Ulaanbaatar day; counts people, not messages", async () => {
  const quick = await draft("quick");
  const complete = await draft("complete");
  await S.publishVersion(quick.id, "a");
  const send = async (senderId: string, status: any, over: Partial<Parameters<typeof S.claimSend>[0]> = {}) => {
    const claim = await S.claimSend(claimInput({ senderId, versionId: quick.id, ...over }));
    assert.equal(claim.claimed, true, `${senderId} ${status}`);
    await S.finishSend(claim.sendId, { status, metaMessageId: status === "sent" ? `m_${senderId}` : null, reason: status === "failed" ? "meta_5xx" : null });
    return claim;
  };

  // 2026-11-06 12:00 Ulaanbaatar day
  await send("p1", "sent");
  await send("p2", "sent");
  await send("p3", "failed");
  const dup = await S.claimSend(claimInput({ senderId: "p1", versionId: quick.id }));
  assert.equal(dup.claimed, false);
  await S.claimSend(claimInput({ senderId: "p1", versionId: quick.id, explicitResend: true })); // burst guard
  await send("p4", "blocked_staff_owned");
  await send("p5", "sent_link_fallback");
  await send("p6", "stale_fallback");
  await send("p7", "no_published_version");
  await send("p8", "dry_run");
  await send("p9", "sent", { edition: "complete", versionId: complete.id });

  // 23:30 UTC on the 6th is 07:30 on the 7th in Ulaanbaatar
  nowMs = Date.parse("2026-11-06T23:30:00.000Z");
  await send("p10", "sent");
  await send("p3", "sent", { edition: "complete", versionId: complete.id });
  // an old row outside the 7-day window
  nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  await send("old", "sent");
  nowMs = Date.parse("2026-11-07T04:00:00.000Z");

  const stats = await S.deliveryStats(7);
  assert.equal(stats.days, 7);
  assert.deepEqual(stats.totals, {
    attempts: 11, sent: 5, linkFallback: 1, staleFallback: 1, failed: 1, blocked: 1, noPublishedVersion: 1, dryRun: 1, inFlight: 0, suppressedDuplicates: 2,
  });
  assert.deepEqual(stats.byStatus, { sent: 5, failed: 1, blocked_staff_owned: 1, sent_link_fallback: 1, stale_fallback: 1, no_published_version: 1, dry_run: 1 });
  assert.deepEqual(stats.byEdition.quick, { attempts: 9, delivered: 4, failed: 1 });
  assert.deepEqual(stats.byEdition.complete, { attempts: 2, delivered: 2, failed: 0 });
  assert.deepEqual(stats.byDay.map((d) => d.day), ["2026-11-06", "2026-11-07"], "ascending, Ulaanbaatar days");
  assert.deepEqual(stats.byDay[0], { day: "2026-11-06", attempts: 9, delivered: 4, failed: 1 });
  assert.deepEqual(stats.byDay[1], { day: "2026-11-07", attempts: 2, delivered: 2, failed: 0 });
  const quickRow = stats.byVersion.find((v) => v.versionId === quick.id)!;
  assert.deepEqual([quickRow.versionNo, quickRow.fileName, quickRow.attempts, quickRow.delivered], [1, "UUDAM_Corporate_2026-11-06_v1.pdf", 9, 4]);
  assert.equal(stats.byVersion.find((v) => v.versionId === complete.id)!.fileName, "UUDAM_Complete_2026-11-06_v1.pdf");
  assert.equal(stats.uniqueRecipients, 7, "p1 p2 p3 p5 p6 p9 p10: people who were given something, p3 counted once");
  assert.equal(stats.successRate, 6 / 7, "delivered (5 sent + 1 link) / (delivered + 1 failed)");
  assert.equal(stats.lastSentAt, "2026-11-06T23:30:00.000Z");
  assert.ok(stats.since < stats.until);
});

test("stats: empty log, window clamps, and no success rate when nothing was attempted", async () => {
  const empty = await S.deliveryStats(0);
  assert.equal(empty.days, 30, "0 falls back to the default");
  assert.deepEqual(empty.byVersion, []);
  assert.deepEqual(empty.byDay, []);
  assert.equal(empty.successRate, null);
  assert.equal(empty.lastSentAt, null);
  assert.equal(empty.uniqueRecipients, 0);
  assert.equal((await S.deliveryStats(100_000)).days, 365);
});

test("stats: a send to a pruned version still counts, without a file name", async () => {
  const old = await draft("quick");
  const newer = await draft("quick");
  const claim = await S.claimSend(claimInput({ versionId: old.id }));
  await S.finishSend(claim.sendId, { status: "sent" });
  await S.pruneOldVersions(1);
  assert.equal(db.versions.some((v) => v.id === old.id), false);
  const stats = await S.deliveryStats(30);
  assert.equal(stats.totals.sent, 1);
  assert.deepEqual([stats.byVersion[0].versionId, stats.byVersion[0].fileName, stats.byVersion[0].versionNo], [old.id, null, null]);
  assert.ok(newer.id);
});

// ---------------------------------------------------------------------------------------------
// Meta attachment cache
// ---------------------------------------------------------------------------------------------

test("fb attachment cache: per version and page, overwrite, clear, and input validation", async () => {
  const v = await draft("quick");
  assert.equal(await S.getCachedFbAttachment(v.id, "page-1"), null);
  await S.cacheFbAttachment(v.id, "page-1", "att-1");
  await S.cacheFbAttachment(v.id, "page-2", "att-2");
  assert.equal(await S.getCachedFbAttachment(v.id, "page-1"), "att-1");
  await S.cacheFbAttachment(v.id, "page-1", "att-1b");
  assert.equal(await S.getCachedFbAttachment(v.id, "page-1"), "att-1b");
  assert.equal(await S.getCachedFbAttachment(v.id, "page-2"), "att-2");
  await S.clearCachedFbAttachment(v.id, "page-1");
  assert.equal(await S.getCachedFbAttachment(v.id, "page-1"), null);
  assert.equal(await S.getCachedFbAttachment("nope", "page-1"), null);
  assert.equal(await S.getCachedFbAttachment(v.id, "bad page!"), null);
  await assert.rejects(S.cacheFbAttachment(v.id, "page-1", "  "), (e: any) => e.code === "invalid_input");
  await assert.rejects(S.cacheFbAttachment("nope", "page-1", "x"), (e: any) => e.code === "invalid_input");
});

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

test("audit: generate, publish and rollback are listed newest first with who and what", async () => {
  const v1 = await draft("quick");
  const v2 = await draft("quick");
  advance(1000);
  await S.publishVersion(v1.id, "boss@example.test");
  advance(1000);
  await S.publishVersion(v2.id, "boss@example.test");
  advance(1000);
  await S.rollbackTo(v1.id, "boss@example.test");
  const entries = await S.listCatalogueAudit(10);
  assert.deepEqual(entries.slice(0, 3).map((e) => e.action), ["rollback", "publish", "publish"]);
  assert.equal(entries[0].actor, "boss@example.test");
  assert.equal(entries[0].edition, "quick");
  assert.equal(entries[0].versionId, v1.id);
  assert.equal(entries.filter((e) => e.action === "generate").length, 2);
  assert.equal((await S.listCatalogueAudit(1)).length, 1);
});

test("actors are cleaned before they are stored", async () => {
  advance(1000);
  const meta = await S.saveDraftVersion({ edition: "quick", snapshot: snapshot(), rendered: rendered(), actor: `  boss\n@example.test${"x".repeat(300)} ` });
  assert.ok(meta.generatedBy && meta.generatedBy.length <= 120 && !/[\n\r]/.test(meta.generatedBy));
  const nobody = await S.saveDraftVersion({ edition: "quick", snapshot: snapshot(), rendered: rendered(), actor: null });
  assert.equal(nobody.generatedBy, null);
});
