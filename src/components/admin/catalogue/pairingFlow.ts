import type { CataloguePairingResponse, CatalogueTesterView } from "@/lib/catalogue/admin/types";

/**
 * The tester set-up as a pure state machine, so the polling success path is unit-tested without a browser.
 *
 *   idle --request--> issuing --issued--> waiting --polled(new/refreshed tester)--> paired
 *                          \--failed--> error            \--tick/polled past the deadline--> expired
 *
 * Nothing here touches the network, the clock or React: the component feeds in the API answers and `Date.now()`.
 * The countdown runs on the BROWSER clock from the moment the code arrived (the server states the lifetime in
 * minutes), so a skewed device clock cannot shorten or lengthen it. Paired detection compares SERVER timestamps
 * with each other only.
 */

export const PAIRING_POLL_MS = 3000;

export type PairingPhase = "idle" | "issuing" | "waiting" | "paired" | "expired" | "error";

export type PairingState = {
  phase: PairingPhase;
  code: string | null;
  /** Browser-clock instant the code stops being valid. */
  deadlineMs: number | null;
  /** Server-clock instant the code was minted (expiresAt minus its lifetime). */
  issuedAtServerMs: number | null;
  /** Testers that already existed when the code was requested: id -> last message they sent (ms), or null. */
  baseline: Record<string, number | null>;
  /** The tester that paired (new, or an existing one that wrote after the code was minted). */
  testerId: string | null;
  error: string | null;
};

export const initialPairing: PairingState = {
  phase: "idle",
  code: null,
  deadlineMs: null,
  issuedAtServerMs: null,
  baseline: {},
  testerId: null,
  error: null,
};

export type PairingEvent =
  | { type: "request"; testers: readonly CatalogueTesterView[] }
  | { type: "issued"; response: Pick<CataloguePairingResponse, "code" | "expiresAt" | "ttlMinutes">; nowMs: number }
  | { type: "failed"; message: string }
  | { type: "polled"; testers: readonly CatalogueTesterView[]; nowMs: number }
  | { type: "tick"; nowMs: number }
  | { type: "reset" };

const ms = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * The tester that paired with the code, or null. A brand-new tester is the normal case; re-pairing a device that is
 * already verified updates its "last message" stamp instead, so a known tester that wrote after the code was minted
 * counts too.
 */
export function detectPairedTester(
  state: Pick<PairingState, "baseline" | "issuedAtServerMs">,
  testers: readonly CatalogueTesterView[],
): CatalogueTesterView | null {
  const fresh = testers.filter((tester) => !(tester.id in state.baseline));
  if (fresh.length > 0) return [...fresh].sort((a, b) => (ms(b.verifiedAt) ?? 0) - (ms(a.verifiedAt) ?? 0))[0]!;
  if (state.issuedAtServerMs === null) return null;
  const issuedAt = state.issuedAtServerMs;
  const rewrote = testers.filter((tester) => {
    const last = ms(tester.lastInboundAt);
    const before = state.baseline[tester.id];
    return last !== null && last >= issuedAt && (before === null || before === undefined || before < issuedAt);
  });
  return [...rewrote].sort((a, b) => (ms(b.lastInboundAt) ?? 0) - (ms(a.lastInboundAt) ?? 0))[0] ?? null;
}

export function reducePairing(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case "request":
      return {
        ...initialPairing,
        phase: "issuing",
        baseline: Object.fromEntries(event.testers.map((tester) => [tester.id, ms(tester.lastInboundAt)])),
      };
    case "issued": {
      if (state.phase !== "issuing") return state;
      const expiresAt = ms(event.response.expiresAt);
      const lifetime = event.response.ttlMinutes * 60_000;
      return {
        ...state,
        phase: "waiting",
        code: event.response.code,
        deadlineMs: event.nowMs + lifetime,
        issuedAtServerMs: expiresAt === null ? null : expiresAt - lifetime,
        error: null,
      };
    }
    case "failed":
      return state.phase === "issuing" ? { ...state, phase: "error", error: event.message } : state;
    case "polled": {
      if (state.phase !== "waiting") return state;
      const paired = detectPairedTester(state, event.testers);
      if (paired) return { ...state, phase: "paired", testerId: paired.id };
      return state.deadlineMs !== null && event.nowMs >= state.deadlineMs ? { ...state, phase: "expired" } : state;
    }
    case "tick":
      return state.phase === "waiting" && state.deadlineMs !== null && event.nowMs >= state.deadlineMs ? { ...state, phase: "expired" } : state;
    case "reset":
      return initialPairing;
  }
}

/** Polling runs only while a code is live and the tab is in front. */
export function shouldPoll(state: Pick<PairingState, "phase">, hidden: boolean): boolean {
  return state.phase === "waiting" && !hidden;
}

export function remainingMs(state: Pick<PairingState, "deadlineMs">, nowMs: number): number {
  return state.deadlineMs === null ? 0 : Math.max(0, state.deadlineMs - nowMs);
}

/** "29:41". Rounds up, so the last second still shows 0:01 rather than 0:00. */
export function formatCountdown(remaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ── What the "send test" button may do right now ────────────────────────────────────────────────

export type TestReadiness =
  | { kind: "ready"; testerId: string }
  | { kind: "no_tester" }
  | { kind: "window_closed"; testerId: string }
  | { kind: "revoked" }
  | { kind: "meta_off" };

export const TEST_READINESS_TEXT: Record<Exclude<TestReadiness["kind"], "ready">, string> = {
  no_tester: "Эхлээд «Тестер холбох» товчийг дарж өөрийн Messenger-ээ холбоно уу.",
  window_closed: "Messenger-ийн цонх хаагдсан байна: та манай Page руу дахин бичнэ үү (дурын мессеж хангалттай).",
  revoked: "Энэ тестерийн эрх цуцлагдсан байна. Шинээр холбоно уу.",
  meta_off: "Meta руу илгээх түр унтраалттай байна. Одоохондоо зөвхөн дээж харж болно.",
};

/**
 * Which state the send button is in. `selectedId` is the tester chosen (auto-selected after pairing); a selected tester
 * that is no longer in the verified list was revoked.
 */
export function testReadiness(input: {
  testers: readonly CatalogueTesterView[];
  selectedId: string | null;
  metaOutboundDisabled: boolean;
}): TestReadiness {
  if (input.metaOutboundDisabled) return { kind: "meta_off" };
  const selected = input.selectedId ? input.testers.find((tester) => tester.id === input.selectedId) : undefined;
  if (input.selectedId && !selected) return { kind: "revoked" };
  if (selected) return selected.windowOpen ? { kind: "ready", testerId: selected.id } : { kind: "window_closed", testerId: selected.id };
  const open = input.testers.find((tester) => tester.windowOpen);
  if (open) return { kind: "ready", testerId: open.id };
  if (input.testers[0]) return { kind: "window_closed", testerId: input.testers[0].id };
  return { kind: "no_tester" };
}
