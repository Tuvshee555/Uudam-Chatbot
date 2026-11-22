import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, ALPHA, BETA, GAMMA, NOW, scriptedChat, toolResults, VERSION } from "./helpers/agentFixtures";
import type { AIChangeProposal, AITripAction, TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

/**
 * The assistant's set_date_sale: a sale fare and/or «Онцлох» on ONE departure date, written on the
 * website's departure row (the regular fare stays, shown struck through). Built from the model's
 * propose_changes, checked by validation, applied and rolled back against an in-memory departure
 * row. Invented trips and fares only; no model, no database, no network.
 */

type Row = Record<string, unknown>;
const NAME = ALPHA.route_name;

/** «Альфа» as the website overlay reads it when 12/9 already has a sale and «Онцлох». */
const ALPHA_ON_SALE: TravelTrip = {
  ...ALPHA,
  extra: {
    ...ALPHA.extra,
    website_departure_deals: [
      { date: "2098-12-09", regular_adult_price: 2_590_000, regular_child_price: 2_290_000, sale_adult_price: 2_390_000, sale_child_price: null, featured: true },
    ],
  },
};

function context(trips: TravelTrip[]) {
  return {
    trips, now: NOW, fetched: new Map(trips.map((trip) => [trip.id, VERSION])), seen: new Set(trips.map((trip) => trip.id)),
    linkTrips: new Set<string>(), linkUnresolved: false, hosted: new Set<string>(),
  };
}

async function build(raw: Row[], trips: TravelTrip[] = [ALPHA_ON_SALE]) {
  const { buildAgentProposal } = await import("../src/lib/assistantAgent/actions");
  return buildAgentProposal(raw, "", context(trips));
}

function proposalOf(built: Awaited<ReturnType<typeof build>>): AIChangeProposal {
  assert.ok("proposal" in built, JSON.stringify(built));
  return built.proposal;
}

const sale = (fields: Row) => ({ action: "set_date_sale", trip_id: ALPHA.id, summary: "", ...fields });

test("a sale below the date's regular fare: one action with the regular fares, what the date showed, and the card line with the percent", async () => {
  const proposal = proposalOf(await build([sale({ date: "2098-12-02", sale: { adult: 2_390_000 }, from_adult: 2_590_000 })]));
  assert.deepEqual(proposal.actions, [{
    action: "set_date_sale", trip_id: ALPHA.id, expected_updated_at: VERSION,
    summary: `«${NAME}» — 12/2 хямдрал: 2,590,000₮ → 2,390,000₮ (−8%)`,
    date: "2098-12-02", sale: { adult: 2_390_000 }, from_adult: 2_590_000,
    regular_adult: 2_590_000, regular_child: 2_290_000, observed_deal: { sale_adult: null, sale_child: null, featured: false },
  }]);
  assert.deepEqual(proposal.conflict_items, [], "the old price he wrote is the date's regular fare: no note");

  // A child sale and «Онцлох» on the same date ride in the same action.
  const both = proposalOf(await build([sale({ date: "2098-12-02", sale: { adult: 2_331_000, child: 2_061_000 }, featured: true })]));
  const { describeChange } = await import("../src/lib/assistantActionText");
  assert.deepEqual(describeChange(both.actions[0], ALPHA_ON_SALE, NOW).lines, [
    "12/2 хямдрал: 2,590,000₮ → 2,331,000₮ (−10%)",
    "12/2 хүүхдийн хямдрал: 2,290,000₮ → 2,061,000₮ (−10%)",
    "12/2: «Онцлох» болно",
  ]);
});

test("a sale that is not below the regular fare is refused with the reason, and the model is not sent round again", async () => {
  const same = await build([sale({ date: "2098-12-02", sale: { adult: 2_590_000 } })]);
  assert.ok("note" in same);
  assert.equal(same.fixable, false);
  assert.match(same.note, /12\/2-ны том хүний хямдралын үнэ 2,590,000₮ нь үндсэн үнэ 2,590,000₮-өөс бага биш тул хямдрал болохгүй/);
  assert.match(same.note, /«12\/2-ны үнийг 2,590,000₮ болго» гэж бичнэ үү/, "the way to a new regular price is said");

  const child = await build([sale({ date: "2098-12-02", sale: { adult: 2_390_000, child: 2_490_000 } })]);
  assert.ok("note" in child);
  assert.match(child.note, /хүүхдийн хямдралын үнэ 2,490,000₮ нь үндсэн үнэ 2,290,000₮-өөс бага биш/);
});

test("the old price he wrote is not the date's regular fare: the action is built and the card says which price the site strikes through", async () => {
  const proposal = proposalOf(await build([sale({ date: "2098-12-02", sale: { adult: 2_390_000 }, from_adult: 2_690_000 })]));
  assert.equal(proposal.actions.length, 1);
  assert.deepEqual(proposal.conflict_items?.map((item) => item.text), [
    `«${NAME}»: Та 2,690,000₮-аас гэж бичсэн ч 12/2-ны том хүний үндсэн үнэ 2,590,000₮ байна — сайт хуучин үнээр 2,590,000₮-ийг зурж харуулна.`,
  ]);
});

test("removing a date's sale, «Онцлох» alone, changing an existing sale, and what is already so", async () => {
  const cleared = proposalOf(await build([sale({ date: "2098-12-09", clear_sale: true })]));
  assert.equal(cleared.actions[0].summary, `«${NAME}» — 12/9: хямдрал арилна (2,390,000₮ → 2,590,000₮)`);
  assert.equal(cleared.actions[0].clear_sale, true);
  assert.deepEqual(cleared.actions[0].observed_deal, { sale_adult: 2_390_000, sale_child: null, featured: true });

  const unfeatured = proposalOf(await build([sale({ date: "2098-12-09", featured: false })]));
  assert.equal(unfeatured.actions[0].summary, `«${NAME}» — 12/9: «Онцлох» хасна`);
  assert.equal(unfeatured.actions[0].sale, undefined, "«Онцлох» alone writes no fare");

  const featured = proposalOf(await build([sale({ date: "2098-12-02", featured: true })]));
  assert.equal(featured.actions[0].summary, `«${NAME}» — 12/2: «Онцлох» болно`);

  const lower = proposalOf(await build([sale({ date: "2098-12-09", sale: { adult: 2_290_000 } })]));
  assert.equal(lower.actions[0].summary, `«${NAME}» — 12/9 хямдрал: 2,590,000₮ → 2,290,000₮ (−12%); 12/9 одоогийн хямдрал: 2,390,000₮ → 2,290,000₮`);

  const nothingToClear = await build([sale({ date: "2098-12-02", clear_sale: true })]);
  assert.ok("note" in nothingToClear);
  assert.match(nothingToClear.note, /12\/2-нд хямдрал аль хэдийн алга/);

  const already = await build([sale({ date: "2098-12-09", sale: { adult: 2_390_000 }, featured: true })]);
  assert.ok("note" in already);
  assert.match(already.note, /12\/9 аль хэдийн ийм хямдрал, «Онцлох»-той байна/);

  // A part that is already so is left out; the rest is proposed.
  const partly = proposalOf(await build([sale({ date: "2098-12-09", sale: { adult: 2_390_000 }, featured: false })]));
  assert.deepEqual([partly.actions[0].sale, partly.actions[0].featured], [undefined, false]);
});

test("a date the trip does not have is sent back to be asked; a day not on the website yet is explained", async () => {
  const unknown = await build([sale({ date: "2098-12-23", sale: { adult: 2_390_000 } })]);
  assert.ok("note" in unknown);
  assert.equal(unknown.fixable, true, "the model can ask which departure");
  assert.match(unknown.note, /12\/23-нд гаралт алга/);

  const unpublished: TravelTrip = { ...ALPHA, departure_dates: [...ALPHA.departure_dates, "2098-12-16"] };
  const notYet = await build([sale({ date: "2098-12-16", sale: { adult: 2_390_000 } })], [unpublished]);
  assert.ok("note" in notYet);
  assert.equal(notYet.fixable, false);
  assert.match(notYet.note, /вэбсайтад хараахан нийтлэгдээгүй тул хямдрал, «Онцлох» тавих боломжгүй/);

  const nothing = await build([sale({ date: "2098-12-02" })]);
  assert.ok("note" in nothing);
  assert.match(nothing.note, /хямдралын үнэ, хямдрал арилгах эсвэл «Онцлох»-ын аль нь болохыг заагаагүй/);
});

test("a date's sale is saved before a price edit of the same trip (it leaves the version as it was); a partner trip may get one", async () => {
  const proposal = proposalOf(await build([
    { action: "set_date_price", trip_id: ALPHA.id, date: "2098-12-02", fares: { adult: { set: 2_690_000 } }, summary: "" },
    sale({ date: "2098-12-09", featured: false }),
  ]));
  assert.deepEqual(proposal.actions.map((action) => action.action), ["set_date_sale", "set_date_price"]);

  // The partner sync never writes a date's sale columns, so the sale stays (not a partner-owned edit).
  const partner = proposalOf(await build([{ action: "set_date_sale", trip_id: GAMMA.id, date: "2098-12-16", sale: { adult: 2_390_000 }, summary: "" }], [GAMMA]));
  assert.match(String(partner.actions[0].summary), /12\/16 хямдрал: 2,590,000₮ → 2,390,000₮ \(−8%\)/);
});

test("the card: verb «Огнооны хямдрал», the same lines live and after the save", async () => {
  const { actionView, describeAction, hasPlannedLines } = await import("../src/lib/adminProposalUtils");
  const proposal = proposalOf(await build([sale({ date: "2098-12-02", sale: { adult: 2_390_000 } })]));
  const action = proposal.actions[0] as unknown as Parameters<typeof describeAction>[0];
  assert.equal(hasPlannedLines(action), true);
  assert.equal(describeAction(action).verb, "Огнооны хямдрал");
  const live = actionView(action, ALPHA_ON_SALE, { live: true, now: NOW });
  const saved = actionView(action, null, { live: false, now: NOW });
  assert.deepEqual(live.lines, ["12/2 хямдрал: 2,590,000₮ → 2,390,000₮ (−8%)"]);
  assert.deepEqual(saved.lines, live.lines);
});

test("validation keeps a sale the planner accepts, fills what an older action lacks, and blocks one that is not below the fare", async () => {
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const proposal = proposalOf(await build([sale({ date: "2098-12-02", sale: { adult: 2_390_000 } })]));
  const ok = validateAIChangeProposal(proposal, [ALPHA_ON_SALE], { now: NOW });
  assert.deepEqual(ok.blocking_conflicts, []);
  assert.deepEqual(ok.proposal.actions, proposal.actions, "the reviewed action is saved as it is");

  const bare = { summary: "", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [],
    actions: [{ action: "set_date_sale", trip_id: ALPHA.id, date: "2098-12-09", featured: false, stray: "x" } as unknown as AITripAction] };
  const filled = validateAIChangeProposal(bare, [ALPHA_ON_SALE], { now: NOW });
  assert.deepEqual(filled.blocking_conflicts, []);
  assert.deepEqual(filled.proposal.actions[0], {
    action: "set_date_sale", trip_id: ALPHA.id, date: "2098-12-09", featured: false,
    regular_adult: 2_590_000, regular_child: 2_290_000, observed_deal: { sale_adult: 2_390_000, sale_child: null, featured: true },
  });

  const above = validateAIChangeProposal({ ...bare, actions: [{ action: "set_date_sale", trip_id: ALPHA.id, date: "2098-12-02", sale: { adult: 2_790_000 } } as AITripAction] }, [ALPHA_ON_SALE], { now: NOW });
  assert.equal(above.blocking_conflicts.length, 1);
  assert.match(above.blocking_conflicts[0], new RegExp(`^«${NAME}»: 12/2-ны том хүний хямдралын үнэ 2,790,000₮`));
  const gone = validateAIChangeProposal({ ...bare, actions: [{ action: "set_date_sale", trip_id: ALPHA.id, date: "2098-12-23", featured: true } as AITripAction] }, [ALPHA_ON_SALE], { now: NOW });
  assert.match(gone.blocking_conflicts[0], /12\/23-нд гаралт алга/);
});

test("the agent: «X-аас Y хүртэл хямдруул» becomes one set_date_sale (no fare nudge); a sale nobody asked for is refused", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const script = scriptedChat([
    () => [{ name: "search_trips", args: { query: "Альфа" } }],
    () => [{ name: "get_trip", args: { trip_id: ALPHA.id } }],
    ({ messages }) => {
      const detail = JSON.parse(toolResults(messages).at(-1)!);
      assert.deepEqual(detail.date_deals, [{ date: "2098-12-09", regular: { adult: 2_590_000, child: 2_290_000 }, sale: { adult: 2_390_000, child: null }, featured: true }]);
      return [{ name: "propose_changes", args: { reply_text: "12/2-нд хямдрал тавина.", actions: [sale({ date: "2098-12-02", sale: { adult: 2_390_000 }, from_adult: 2_590_000, summary: "12/2 хямдрал" })] } }];
    },
  ]);
  const run = await runAgent({ instruction: "Альфа 12/2-ны үнийг 2,590,000-аас 2,390,000 хүртэл хямдруул", trips: [ALPHA_ON_SALE, BETA], today: NOW, deps: agentDeps(script.chat) });
  assert.equal(run.outcome.kind, "proposal", JSON.stringify(run.outcome));
  const actions = (run.outcome as unknown as { proposal: AIChangeProposal }).proposal.actions;
  assert.deepEqual(actions.map((action) => [action.action, action.summary]), [["set_date_sale", `«${NAME}» — 12/2 хямдрал: 2,590,000₮ → 2,390,000₮ (−8%)`]]);
  assert.equal(script.calls, 3, "a sale counts as the fare change his message asks for");

  const slipped = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: ALPHA.id } }],
    () => [{ name: "propose_changes", args: { reply_text: "", actions: [
      { action: "set_date_state", trip_id: ALPHA.id, date: "2098-12-02", state: "full", summary: "" },
      sale({ date: "2098-12-02", sale: { adult: 2_390_000 } }),
    ] } }],
  ]);
  const guarded = await runAgent({ instruction: "Альфа 12/2-ны аяллыг дүүрсэн болго", trips: [ALPHA_ON_SALE], today: NOW, deps: agentDeps(slipped.chat) });
  const proposal = (guarded.outcome as unknown as { proposal: AIChangeProposal }).proposal;
  assert.deepEqual(proposal.actions.map((action) => action.action), ["set_date_state"]);
  assert.ok(proposal.conflicts.some((line) => /таны мессежид огноонд хямдрал, «Онцлох» тавих заавар алга/.test(line)), proposal.conflicts.join(" | "));
});

test("the simple mode (no model) never reads a sale as a new regular price", async () => {
  const { asksDateSale } = await import("../src/lib/dateSale");
  assert.equal(asksDateSale("«Аялал А» 12/9-ний аяллыг 2,590,000-аас 2,390,000 хүртэл хямдруул"), true);
  assert.equal(asksDateSale("ene aylalin 12/9-iig 2,590,000-aas 2,390,000 hurtel hymdruulsan bolgo"), true);
  assert.equal(asksDateSale("12/9-ний хямдралыг болиул"), true);
  assert.equal(asksDateSale("12/9-ийг онцлох болго"), true);
  assert.equal(asksDateSale("12/9-ний үнийг 100 мянгаар хямдруул"), false, "a regular price shift stays the brain's");
  assert.equal(asksDateSale("12/9 дүүрсэн"), false);
});

// ─── apply and rollback on an in-memory website departure row ────────────────

type Departure = { id: string; date: string; price: number | null; childPrice: number | null; salePrice: number | null; saleChildPrice: number | null; isFeatured: boolean; status: string };

async function harness(rows: Departure[]) {
  const apply = await import("../src/lib/travelAIApply");
  const { dealFromRow } = await import("../src/lib/departureDeals");
  const departures = rows.map((row) => ({ ...row }));
  const notified: string[][] = [];
  const values = (row: Departure) => ({ salePrice: row.salePrice, saleChildPrice: row.saleChildPrice, isFeatured: row.isFeatured });
  const live = (tripId: string, date: string) => departures.filter((row) => tripId === ALPHA.id && row.date === date && !["CANCELLED", "DEPARTED"].includes(row.status));
  // The trip as the read path overlays it: availability and the deals from the same rows.
  const read = (): TravelTrip => ({
    ...ALPHA,
    extra: {
      ...ALPHA.extra,
      website_departure_availability: departures.map((row) => ({ date: row.date, status: row.status, seatsLeft: null })),
      website_departure_deals: departures.map((row) => dealFromRow(row)).filter(Boolean),
    },
  });
  apply.setAIApplyDepsForTests({
    now: () => NOW,
    getTripById: async (id) => (id === ALPHA.id ? read() : null),
    notifyWebsite: async (slugs) => { notified.push(slugs); },
    readDepartureDeal: async (tripId, date) => {
      const row = live(tripId, date)[0];
      return row ? { id: row.id, date: row.date, before: values(row), regularAdult: row.price, regularChild: row.childPrice } : null;
    },
    changeDepartureDeal: async (tripId, date, patch) => ({
      slug: "alfa-hotyn-aylal",
      rows: live(tripId, date).map((row) => {
        const before = values(row);
        if (patch.salePrice !== undefined) row.salePrice = patch.salePrice;
        if (patch.saleChildPrice !== undefined) row.saleChildPrice = patch.saleChildPrice;
        if (patch.isFeatured !== undefined) row.isFeatured = patch.isFeatured;
        return { id: row.id, date: row.date, before, after: values(row), regularAdult: row.price, regularChild: row.childPrice };
      }),
    }),
    // As websiteTripSync.restoreDepartureDeals: nothing when already back, refused when a row was edited since.
    restoreDepartureDeals: async (recorded) => {
      const same = (a: ReturnType<typeof values>, b: ReturnType<typeof values>) => a.salePrice === b.salePrice && a.saleChildPrice === b.saleChildPrice && a.isFeatured === b.isFeatured;
      const now = new Map(departures.map((row) => [row.id, values(row)]));
      if (recorded.every((row) => now.has(row.id) && same(now.get(row.id)!, row.before))) return { restored: 0, changedSince: [] };
      const changedSince = recorded.filter((row) => !now.has(row.id) || !same(now.get(row.id)!, row.after)).map((row) => row.id);
      if (changedSince.length) return { restored: 0, changedSince };
      for (const row of recorded) Object.assign(departures.find((entry) => entry.id === row.id)!, row.before);
      return { restored: recorded.length, changedSince: [] };
    },
  });
  return { apply, departures, notified, done: () => apply.setAIApplyDepsForTests(null) };
}

const ROWS: Departure[] = [
  { id: "dep-2", date: "2098-12-02", price: 2_590_000, childPrice: 2_290_000, salePrice: null, saleChildPrice: null, isFeatured: false, status: "OPEN" },
  { id: "dep-9", date: "2098-12-09", price: 2_590_000, childPrice: 2_290_000, salePrice: 2_390_000, saleChildPrice: null, isFeatured: true, status: "OPEN" },
];

async function builtAction(raw: Row): Promise<AITripAction> {
  return proposalOf(await build([sale(raw)])).actions[0];
}

test("apply writes the sale on the date's website row, refreshes the page, and rollback puts the row back (once)", async () => {
  const h = await harness(ROWS);
  try {
    const action = await builtAction({ date: "2098-12-02", sale: { adult: 2_390_000, child: 2_090_000 }, featured: true });
    const saved = await h.apply.applyAIAction(action);
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.message, `"${NAME}" — 12/2 хямдрал: 2,590,000₮ → 2,390,000₮ (−8%); 12/2 хүүхдийн хямдрал: 2,290,000₮ → 2,090,000₮ (−9%); 12/2: «Онцлох» болно`);
    assert.deepEqual(h.departures[0], { ...ROWS[0], salePrice: 2_390_000, saleChildPrice: 2_090_000, isFeatured: true });
    assert.deepEqual(h.departures[1], ROWS[1], "the other date is untouched");
    assert.deepEqual(h.notified, [["alfa-hotyn-aylal"]]);
    const snapshot = saved.snapshot!;
    assert.deepEqual(snapshot.departure_deal_rows, [{
      id: "dep-2", date: "2098-12-02", regularAdult: 2_590_000, regularChild: 2_290_000,
      before: { salePrice: null, saleChildPrice: null, isFeatured: false }, after: { salePrice: 2_390_000, saleChildPrice: 2_090_000, isFeatured: true },
    }]);
    assert.equal(snapshot.before, null, "the trip record is not written");

    // As rollback reads it back from rollback_json.
    const stored = h.apply.readStoredSnapshotsForTests(JSON.parse(JSON.stringify([snapshot])));
    assert.deepEqual(stored[0].departure_deal_rows, snapshot.departure_deal_rows);
    const undone = await h.apply.rollbackSnapshots(stored);
    assert.equal(undone.failed, false, undone.results.join(" | "));
    assert.deepEqual(h.departures[0], ROWS[0]);
    assert.deepEqual(h.notified.at(-1), ["alfa-hotyn-aylal"]);
    const again = await h.apply.rollbackSnapshots(stored);
    assert.equal(again.failed, false, "a second rollback finds the row already back");
    assert.equal(h.notified.length, 2, "nothing written, nothing refreshed the second time");
  } finally {
    h.done();
  }
});

test("clearing a sale restores the regular fare; a date edited after the save is not rolled over", async () => {
  const h = await harness(ROWS);
  try {
    const action = await builtAction({ date: "2098-12-09", clear_sale: true });
    const saved = await h.apply.applyAIAction(action);
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.message, `"${NAME}" — 12/9: хямдрал арилна (2,390,000₮ → 2,590,000₮)`);
    assert.deepEqual([h.departures[1].salePrice, h.departures[1].saleChildPrice, h.departures[1].isFeatured], [null, null, true], "«Онцлох» stays");
    // Staff set another sale with the date button meanwhile.
    h.departures[1].salePrice = 2_190_000;
    const undone = await h.apply.rollbackSnapshots([saved.snapshot!]);
    assert.equal(undone.failed, true);
    assert.match(undone.results[0], /12\/9-ны хямдрал, «Онцлох»-ыг энэ өөрчлөлтөөс хойш өөр хүн \(эсвэл сайт\) өөрчилсөн тул буцаасангүй/);
    assert.equal(h.departures[1].salePrice, 2_190_000, "the later edit is kept");
  } finally {
    h.done();
  }
});

test("apply refuses a date changed since the proposal, a sale no longer below the site's fare, and a stale trip; writes nothing when it is already so", async () => {
  const h = await harness(ROWS);
  try {
    const action = await builtAction({ date: "2098-12-02", sale: { adult: 2_390_000 } });
    h.departures[0].isFeatured = true;
    const changed = await h.apply.applyAIAction(action);
    assert.equal(changed.ok, false);
    assert.match(changed.message, /12\/2-ны хямдрал, «Онцлох» энэ саналыг гаргаснаас хойш өөрчлөгдсөн байна/);
    h.departures[0].isFeatured = false;

    h.departures[0].price = 2_290_000;
    const above = await h.apply.applyAIAction(action);
    assert.equal(above.ok, false);
    assert.match(above.message, /12\/2-ны том хүний хямдралын үнэ 2,390,000₮ нь сайтын үндсэн үнэ 2,290,000₮-өөс бага биш тул хадгалсангүй/);
    h.departures[0].price = 2_590_000;

    const stale = await h.apply.applyAIAction({ ...action, expected_updated_at: "2098-09-01T00:00:00.000Z" });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /энэ саналыг гаргаснаас хойш өөрчлөгдсөн байна/);

    h.departures[0].salePrice = 2_390_000;
    const already = await h.apply.applyAIAction(action);
    assert.equal(already.ok, true);
    assert.equal(already.snapshot, undefined, "nothing written, nothing to undo");
    assert.match(already.message, /аль хэдийн ийм хямдрал/);
    assert.deepEqual(h.notified, [], "no write, no page refresh");
  } finally {
    h.done();
  }
});
