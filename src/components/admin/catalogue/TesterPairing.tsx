import { useEffect, useReducer, useState } from "react";
import { Alert, Badge, Button, Card, Modal, Spinner, useToast } from "@/components/ui";
import type { CatalogueTesterView } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { formatStamp } from "./shared";
import { PAIRING_POLL_MS, formatCountdown, initialPairing, reducePairing, remainingMs, shouldPoll } from "./pairingFlow";
import { useVisiblePoll } from "./useVisiblePoll";

/** One verified tester: name, masked tail, and whether Messenger's 24 hour window is open. No technical ids. */
function TesterRow({ tester, selected, onRevoke }: { tester: CatalogueTesterView; selected: boolean; onRevoke: (tester: CatalogueTesterView) => void }) {
  const name = tester.label || "Миний Messenger";
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">
          {name} <span className="font-normal text-ink-muted">{tester.masked}</span>
          {selected && <Badge tone="brand" className="ml-2">Сонгогдсон</Badge>}
        </span>
        <span className="block text-xs text-ink-muted">
          {tester.windowOpen
            ? `Хүлээн авч чадна · ${formatStamp(tester.windowClosesAt)} хүртэл`
            : tester.lastInboundAt
              ? `Сүүлд бичсэн: ${formatStamp(tester.lastInboundAt)}`
              : "Одоогоор мессеж бичээгүй"}
        </span>
      </span>
      <Badge tone={tester.windowOpen ? "success" : "warning"} dot>{tester.windowOpen ? "Messenger цонх нээлттэй" : "Messenger цонх хаагдсан"}</Badge>
      <Button size="sm" variant="secondary" onClick={() => onRevoke(tester)} aria-label={`${name}: эрхийг цуцлах`}>Цуцлах</Button>
    </li>
  );
}

/** Steps shown while the code is waiting for the staff member's message. Plain words, in the order they are done. */
export const PAIRING_STEPS: readonly string[] = [
  "Messenger-ээ нээгээд манай Page руу орно",
  "Энэ кодыг яг хэвээр нь бичиж илгээнэ",
  "Энд автоматаар «Холбогдлоо» гарна",
];

/**
 * The code card: a big code, Copy, the three steps and a live countdown. Rendered from plain props so it is tested
 * without a browser; the stateful wrapper below feeds it.
 */
export function PairingCodeCard({ code, remaining, onCopy, onNewCode, onCancel, busy }: {
  code: string;
  remaining: number;
  onCopy: () => void;
  onNewCode: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4" aria-live="polite">
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink">
        {PAIRING_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-brand/40 bg-brand-soft p-5">
        <code className="select-all break-all font-mono text-3xl font-bold tracking-widest text-ink" aria-label="Холбох код">{code}</code>
        <Button variant="secondary" onClick={onCopy}>
          Хуулах
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
          <Spinner />
          <span>Холбогдохыг хүлээж байна… Код <strong className="tabular-nums text-ink">{formatCountdown(remaining)}</strong> хүртэл хүчинтэй.</span>
        </p>
        <span className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onNewCode} loading={busy}>Шинэ код</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Болих</Button>
        </span>
      </div>
      <p className="text-xs text-ink-muted">Кодыг зөвхөн нэг удаа ашиглана. Бот зөвхөн яг кодыг л хүлээж авдаг тул өөр үг нэмж бичихгүй.</p>
    </div>
  );
}

/**
 * «Тестер холбох»: one button, one big code, three plain steps. The panel then watches for the message by itself
 * (every few seconds while the tab is in front, stopping when it pairs, expires or the screen closes) and tells the
 * parent which tester just paired so it is selected for the test send. The code proves the person holding the
 * Messenger account is the signed-in staff member; the id behind it never reaches this browser.
 */
export function TesterPairing({ admin, selectedTesterId, onPaired, onRevoked }: {
  admin: CatalogueAdmin;
  selectedTesterId: string | null;
  onPaired: (testerId: string) => void;
  onRevoked?: (testerId: string) => void;
}) {
  const toast = useToast();
  const [pairing, dispatch] = useReducer(reducePairing, initialPairing);
  const [now, setNow] = useState(() => Date.now());
  const [revoking, setRevoking] = useState<CatalogueTesterView | null>(null);
  const [busy, setBusy] = useState(false);
  const testSend = admin.state?.testSend;
  const testers = testSend?.testers ?? [];
  const { api, reload } = admin;

  // The countdown; also the expiry check when the poll cannot reach the server.
  useEffect(() => {
    if (pairing.phase !== "waiting") return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      dispatch({ type: "tick", nowMs: at });
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing.phase]);

  // useVisiblePoll itself skips ticks while the tab is hidden and fires at once when it returns.
  useVisiblePoll(
    async () => {
      const response = await api.testers();
      dispatch({ type: "polled", testers: response.testers, nowMs: Date.now() });
    },
    PAIRING_POLL_MS,
    shouldPoll(pairing, false),
  );

  // Paired: refresh the screen's own state once and select the new tester.
  const pairedId = pairing.phase === "paired" ? pairing.testerId : null;
  useEffect(() => {
    if (!pairedId) return;
    onPaired(pairedId);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per pairing
  }, [pairedId]);

  async function issue() {
    dispatch({ type: "request", testers });
    try {
      const response = await api.pairTester("");
      const at = Date.now();
      setNow(at);
      dispatch({ type: "issued", response, nowMs: at });
    } catch (err) {
      dispatch({ type: "failed", message: err instanceof Error ? err.message : "Холбох код үүсгэж чадсангүй." });
    }
  }

  async function copy() {
    if (!pairing.code) return;
    try {
      await navigator.clipboard.writeText(pairing.code);
      toast.success("Код хуулагдлаа.");
    } catch {
      toast.info("Кодыг гараар хуулна уу.");
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeTester(revoking.id);
      toast.success("Тестерийн эрхийг цуцаллаа.");
      onRevoked?.(revoking.id);
      setRevoking(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Цуцалж чадсангүй.");
    } finally {
      setBusy(false);
    }
  }

  if (!testSend) return null;
  const pairedTester = pairedId ? testers.find((tester) => tester.id === pairedId) : undefined;
  const hasTesters = testers.length > 0;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">1. Тестер холбох</h3>
          <p className="text-sm text-ink-muted">Нэг удаа хийнэ. Код нь таны өөрийн Messenger гэдгийг баталгаажуулна; жинхэнэ хэрэглэгчид хэзээ ч сонгогдохгүй.</p>
        </div>
        {pairing.phase === "idle" && (
          <Button size="lg" variant={hasTesters ? "secondary" : "primary"} onClick={() => void issue()}>
            {hasTesters ? "Өөр Messenger холбох" : "Тестер холбох"}
          </Button>
        )}
      </div>

      {testSend.testersError && <Alert tone="warning">{testSend.testersError}</Alert>}

      {pairing.phase === "issuing" && (
        <p className="flex items-center gap-2 text-sm text-ink-muted" role="status"><Spinner /> Код үүсгэж байна…</p>
      )}
      {pairing.phase === "waiting" && pairing.code && (
        <PairingCodeCard
          code={pairing.code}
          remaining={remainingMs(pairing, now)}
          onCopy={() => void copy()}
          onNewCode={() => void issue()}
          onCancel={() => dispatch({ type: "reset" })}
          busy={false}
        />
      )}
      {pairing.phase === "paired" && (
        <Alert tone="success">
          Холбогдлоо{pairedTester ? `: ${pairedTester.label || "Миний Messenger"} ${pairedTester.masked}` : ""}. Одоо доороос «Тест илгээх» дарна уу.{" "}
          <button type="button" className="font-semibold underline" onClick={() => dispatch({ type: "reset" })}>Болсон</button>
        </Alert>
      )}
      {pairing.phase === "expired" && (
        <Alert tone="warning">
          Кодын хугацаа дууссан. <button type="button" className="font-semibold underline" onClick={() => void issue()}>Шинэ код авах</button>
        </Alert>
      )}
      {pairing.phase === "error" && (
        <Alert tone="danger">
          {pairing.error} <button type="button" className="font-semibold underline" onClick={() => void issue()}>Дахин оролдох</button>
        </Alert>
      )}

      {!hasTesters && pairing.phase === "idle" && (
        <Alert tone="info">Холбогдсон тестер алга. «Тестер холбох» дарахад гарах кодыг Messenger-ээс манай Page руу бичихэд л болно.</Alert>
      )}
      {hasTesters && (
        <ul className="divide-y divide-line" aria-label="Холбогдсон тестерүүд">
          {testers.map((tester) => (
            <TesterRow key={tester.id} tester={tester} selected={tester.id === selectedTesterId} onRevoke={setRevoking} />
          ))}
        </ul>
      )}

      <Modal
        open={revoking !== null}
        onClose={() => (busy ? undefined : setRevoking(null))}
        title="Тестерийн эрхийг цуцлах уу?"
        description="Цуцалсан тестерт дахин PDF илгээхгүй. Дахин нэмэхийн тулд шинэ кодоор холбоно."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)} disabled={busy}>Болих</Button>
            <Button onClick={() => void revoke()} loading={busy}>Цуцлах</Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">{revoking ? `${revoking.label || "Миний Messenger"} ${revoking.masked}` : ""}</p>
      </Modal>
    </Card>
  );
}
