import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Input, Modal, useToast } from "@/components/ui";
import type { CataloguePairingResponse, CatalogueTesterView } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { formatStamp } from "./shared";

const POLL_MS = 4000;

/** One verified tester: label, masked tail, when it was verified and whether Messenger's 24 h window is open. */
function TesterRow({ tester, onRevoke }: { tester: CatalogueTesterView; onRevoke: (tester: CatalogueTesterView) => void }) {
  const name = tester.label || "Нэргүй туршигч";
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{name} <span className="font-normal text-ink-muted">{tester.masked}</span></span>
        <span className="block text-xs text-ink-muted">Баталгаажсан: {formatStamp(tester.verifiedAt)}</span>
        <span className="block text-xs text-ink-muted">
          {tester.windowOpen
            ? `Цонх ${formatStamp(tester.windowClosesAt)} хүртэл нээлттэй`
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

/** The pairing dialog: a one-time code the signed-in staff member sends from their own Messenger. */
function PairingDialog({ admin, open, onClose, knownIds }: { admin: CatalogueAdmin; open: boolean; onClose: () => void; knownIds: string[] }) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<CataloguePairingResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [baseline, setBaseline] = useState<string[]>([]);

  // While a code is live, look for the new tester every few seconds.
  const live = issued !== null && Date.parse(issued.expiresAt) > now;
  const { reload } = admin;
  useEffect(() => {
    if (!open || !live) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, live, reload]);

  const paired = issued !== null && (admin.state?.testSend.testers ?? []).some((tester) => !baseline.includes(tester.id));

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setBaseline(knownIds);
      setIssued(await admin.api.pairTester(label.trim()));
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Холбох код үүсгэж чадсангүй.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      toast.success("Код хуулагдлаа.");
    } catch {
      toast.info("Кодыг гараар хуулна уу.");
    }
  }

  function close() {
    setIssued(null);
    setLabel("");
    setError(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Тестер холбох"
      description="Өөрийн Messenger-ээс манай Page руу нэг удаа код бичиж төхөөрөмжөө баталгаажуулна. ID хайх, Vercel-д юм засах шаардлагагүй."
      footer={
        issued ? (
          <Button onClick={close}>{paired ? "Болсон" : "Хаах"}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Цуцлах</Button>
            <Button onClick={() => void create()} loading={busy}>Код үүсгэх</Button>
          </>
        )
      }
    >
      {!issued ? (
        <div className="space-y-3">
          <Input label="Төхөөрөмжийн нэр (заавал биш)" placeholder="Жишээ: Миний утас" maxLength={40} value={label} onChange={(event) => setLabel(event.target.value)} />
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      ) : paired ? (
        <Alert tone="success">Туршигч амжилттай холбогдлоо. Одоо дээрх жагсаалтаас сонгоод PDF илгээж болно.</Alert>
      ) : (
        <div className="space-y-3" aria-live="polite">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
            <li>Өөрийн утсаараа Messenger нээж, манай Page руу очно.</li>
            <li>Доорх кодыг <strong>өөр үггүйгээр, яг ийм байдлаар</strong> илгээнэ.</li>
            <li>Хэдэн секундын дотор энэ цонхонд «холбогдлоо» гэж гарна.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line-strong bg-surface-sunken p-4">
            <code className="select-all font-mono text-xl font-semibold tracking-wider text-ink" aria-label="Холбох код">{issued.code}</code>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>Хуулах</Button>
          </div>
          <p className="text-xs text-ink-muted">
            {live ? `Код ${formatStamp(issued.expiresAt)} хүртэл (${issued.ttlMinutes} минут) хүчинтэй, зөвхөн нэг удаа ашиглагдана.` : "Кодын хугацаа дууссан. Хаагаад шинэ код үүсгэнэ үү."}
          </p>
          <p className="text-xs text-ink-muted">Page эсвэл таны яриа түр зогссон, ажилтан эзэмшсэн байвал бот код хүлээж авахгүй: тэр үед яриаг «Ботод буцаах» хийнэ үү.</p>
        </div>
      )}
    </Modal>
  );
}

/** Verified testers + the "Тестер холбох" flow. This replaces hunting for a PSID or editing a Vercel variable. */
export function TesterPairing({ admin }: { admin: CatalogueAdmin }) {
  const toast = useToast();
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<CatalogueTesterView | null>(null);
  const [busy, setBusy] = useState(false);
  const testSend = admin.state?.testSend;
  if (!testSend) return null;
  const { testers } = testSend;

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await admin.api.revokeTester(revoking.id);
      toast.success("Туршигчийн эрхийг цуцаллаа.");
      setRevoking(null);
      await admin.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Цуцалж чадсангүй.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">Баталгаажсан туршигчид</h3>
          <p className="text-sm text-ink-muted">Зөвхөн кодоор өөрөө холбосон Messenger данс. Жинхэнэ хэрэглэгчид хэзээ ч сонгогдохгүй.</p>
        </div>
        <Button onClick={() => setPairing(true)}>Тестер холбох</Button>
      </div>
      {testSend.testersError && <Alert tone="warning">{testSend.testersError}</Alert>}
      {testers.length === 0 ? (
        <Alert tone="info">
          Баталгаажсан туршигч алга. Нэг удаа хийх ганц алхам: «Тестер холбох» дарж гарсан кодыг өөрийн Messenger-ээс манай Page руу бичнэ үү. Тэгвэл төхөөрөмж энд автоматаар бүртгэгдэнэ.
        </Alert>
      ) : (
        <ul className="divide-y divide-line" aria-label="Баталгаажсан туршигчид">
          {testers.map((tester) => (
            <TesterRow key={tester.id} tester={tester} onRevoke={setRevoking} />
          ))}
        </ul>
      )}
      <PairingDialog admin={admin} open={pairing} onClose={() => setPairing(false)} knownIds={testers.map((tester) => tester.id)} />
      <Modal
        open={revoking !== null}
        onClose={() => (busy ? undefined : setRevoking(null))}
        title="Туршигчийн эрхийг цуцлах уу?"
        description="Цуцалсан туршигчид дахин PDF илгээхгүй. Дахин нэмэхийн тулд шинэ кодоор холбоно."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)} disabled={busy}>Болих</Button>
            <Button onClick={() => void revoke()} loading={busy}>Цуцлах</Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">{revoking ? `${revoking.label || "Нэргүй туршигч"} ${revoking.masked}` : ""}</p>
      </Modal>
    </Card>
  );
}
