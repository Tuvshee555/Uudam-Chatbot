import { useState } from "react";
import { Alert, Badge, Button, Card, Modal, Select, useToast } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import { formatBytes } from "@/lib/adminUtils";
import type { CatalogueTestSendResponse } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { EDITION_LABEL, formatStamp } from "./shared";
import { TesterPairing } from "./TesterPairing";

const OUTCOME_LABEL: Record<string, string> = {
  dry_run: "Дээж: илгээгээгүй",
  sent: "Илгээгдлээ",
  sent_link_fallback: "Файл биш, холбоосоор илгээгдлээ",
  stale_fallback: "Хуучирсан тул зөвхөн холбоос явлаа",
  duplicate_suppressed: "Давхардал тул илгээгээгүй",
  blocked_staff_owned: "Ажилтан яриаг эзэмшсэн тул илгээгээгүй",
  blocked_paused: "Бот түр зогссон тул илгээгээгүй",
  blocked_window: "24 цагийн цонх хаагдсан тул илгээгээгүй (туршигч Page руу дахин бичнэ үү)",
  blocked_killswitch: "Meta унтраалттай тул илгээгээгүй",
  no_published_version: "Нийтлэгдсэн хувилбар алга",
  failed: "Амжилтгүй",
};

/** Dry-run by default: shows the exact Messenger requests. A real send reaches only a verified tester (or an env recipient). */
export function TestSendPanel({ admin }: { admin: CatalogueAdmin }) {
  const toast = useToast();
  const { state, api } = admin;
  // "published:quick" | "published:complete" | "version:<id>" (a draft can be tested before it is published)
  const [target, setTarget] = useState("published:quick");
  // "tester:<id>" | "env:<ref>" | "" (first reachable)
  const [recipient, setRecipient] = useState("");
  const [armed, setArmed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<"dry" | "real" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogueTestSendResponse | null>(null);

  if (!state) return null;
  const { testSend } = state;
  const testable = admin.versions.filter((candidate) => candidate.status !== "superseded");
  const chosenVersion = target.startsWith("version:") ? testable.find((candidate) => candidate.id === target.slice(8)) ?? null : null;
  const publishedEdition = target === "published:complete" ? "complete" : "quick";
  const file = chosenVersion ?? state.editions[publishedEdition].published;
  // The recipients a REAL send can reach right now: a verified tester with an open window, or an env recipient.
  const options = [
    ...testSend.testers.map((tester) => ({ value: `tester:${tester.id}`, label: `${tester.label || "Нэргүй туршигч"} ${tester.masked}${tester.windowOpen ? "" : " (цонх хаагдсан)"}`, usable: tester.windowOpen })),
    ...testSend.recipients.map((entry) => ({ value: `env:${entry.ref}`, label: `Туршигч ${entry.label}`, usable: true })),
  ];
  const chosen = options.find((option) => option.value === recipient) ?? options.find((option) => option.usable) ?? options[0] ?? null;
  const recipientArgs = chosen
    ? chosen.value.startsWith("tester:") ? { testerId: chosen.value.slice(7) } : { recipientRef: chosen.value.slice(4) }
    : {};
  const canSendReal = testSend.realSendPossible && Boolean(chosen?.usable);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "real");
    setError(null);
    try {
      const response = await api.testSend({
        ...(chosenVersion ? { versionId: chosenVersion.id } : { edition: publishedEdition }),
        dryRun,
        ...recipientArgs,
      });
      setResult(response);
      if (!dryRun) {
        toast.success(response.outcome.status === "sent" ? "Туршилтын PDF илгээгдлээ." : OUTCOME_LABEL[response.outcome.status] ?? response.outcome.status);
        setArmed(false);
      }
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      setError(err instanceof Error ? err.message : "Туршилтын илгээлт амжилтгүй боллоо.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Туршилтын илгээлт"
        description="Жинхэнэ хэрэглэгчид хэзээ ч очихгүй. Дээж нь юу илгээгдэхийг үзүүлнэ; жинхэнэ илгээлт зөвхөн өөрөө код бичиж баталгаажуулсан туршигчид явна."
      />
      <TesterPairing admin={admin} />
      <div className="max-w-xl">
        <Select label="Туршах файл" value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="published:quick">Нийтлэгдсэн · {EDITION_LABEL.quick}</option>
          <option value="published:complete">Нийтлэгдсэн · {EDITION_LABEL.complete}</option>
          {testable.map((candidate) => (
            <option key={candidate.id} value={`version:${candidate.id}`}>
              {`v${candidate.versionNo} · ${EDITION_LABEL[candidate.edition]} · ${candidate.status === "draft" ? "ноорог" : "нийтлэгдсэн"} · ${formatStamp(candidate.generatedAt)}`}
            </option>
          ))}
        </Select>
      </div>

      {!file ? (
        <Alert tone="info">{EDITION_LABEL[publishedEdition]}-ийн нийтлэгдсэн хувилбар алга. Ноорог хувилбарыг дээрээс сонгож туршиж болно, эсвэл эхлээд нийтэлнэ үү.</Alert>
      ) : (
        <p className="text-sm text-ink-muted">
          Илгээгдэх файл: <span className="font-semibold text-ink">{file.fileName}</span> · v{file.versionNo} · {formatBytes(file.sizeBytes)} · {file.pageCount} хуудас · {file.status === "draft" ? "ноорог (нийтлээгүй)" : `нийтэлсэн ${formatStamp(file.publishedAt)}`}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-5">
          <h3 className="text-base font-semibold text-ink">Дээж (dry-run)</h3>
          <p className="text-sm text-ink-muted">Meta руу юу ч илгээхгүй. Нэг файл болон нэг текстийн яг бодит хүсэлтийн бүтцийг харуулна.</p>
          <Button onClick={() => void run(true)} loading={busy === "dry"} disabled={!file || busy !== null}>Дээж харах</Button>
        </Card>

        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Жинхэнэ туршилт</h3>
            <Badge tone={testSend.realSendPossible ? "success" : "neutral"} dot>{testSend.realSendPossible ? "Боломжтой" : "Хаалттай"}</Badge>
          </div>
          {testSend.blockedReason && <Alert tone="info">{testSend.blockedReason}</Alert>}
          {options.length > 0 && (
            <Select label="Хүлээн авагч (баталгаажсан туршигч)" value={chosen?.value ?? ""} onChange={(event) => setRecipient(event.target.value)} disabled={!testSend.realSendPossible}>
              {options.map((option) => (
                <option key={option.value} value={option.value} disabled={!option.usable}>{option.label}</option>
              ))}
            </Select>
          )}
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              checked={armed}
              disabled={!canSendReal || !file}
              onChange={(event) => setArmed(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>Дээрх туршигчид PDF-г жинхэнээр илгээнэ. Тэр сүүлийн 24 цагт Page руу мессеж бичсэн (цонх нээлттэй) байх ёстой.</span>
          </label>
          <Button variant="secondary" onClick={() => setConfirmOpen(true)} disabled={!armed || !canSendReal || !file || busy !== null}>
            Туршилтаар илгээх
          </Button>
        </Card>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {result && (
        <Card className="space-y-3 p-5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{result.dryRun ? "Дээжийн үр дүн" : "Илгээлтийн үр дүн"}</h3>
            <Badge tone={result.outcome.status === "sent" ? "success" : result.outcome.status === "failed" ? "danger" : "neutral"} dot>
              {OUTCOME_LABEL[result.outcome.status] ?? result.outcome.status}
            </Badge>
            {result.outcome.reason && <span className="text-xs text-ink-muted">({result.outcome.reason})</span>}
          </div>
          {result.payload ? (
            <>
              <p className="text-sm text-ink-muted">
                Хүлээн авагч: {result.tester ? `${result.tester.label || "Нэргүй туршигч"} ${result.tester.masked}` : result.payload.recipient} · Файл: {result.payload.file.name} ({formatBytes(result.payload.file.sizeBytes)}{result.payload.file.pages ? `, ${result.payload.file.pages} хуудас` : ""}) · {result.payload.attachmentSource === "cached_attachment_id" ? "Meta-д өмнө нь байршсан файл дахин ашиглана" : "Илгээх үед Meta-д байршуулна"}
              </p>
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Messenger Send API: {result.payload.messages.length} хүсэлт, илгээх дарааллаар (1 текст, 1 файл)</p>
              <ol className="space-y-3" aria-label="Messenger хүсэлтүүд">
                {result.payload.messages.map((message, index) => (
                  <li key={`${message.kind}-${index}`}>
                    <p className="mb-1 text-xs font-semibold text-ink">{index + 1}. {message.kind === "file" ? "Файл хавсралт" : "Текст"}</p>
                    <pre
                      tabIndex={0}
                      aria-label={`Messenger хүсэлт ${index + 1}`}
                      className="max-h-[260px] overflow-auto rounded-lg bg-surface-sunken p-3 text-xs leading-5 text-ink"
                    >
                      {JSON.stringify(message.body, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
              {result.payload.fallbackText && (
                <p className="text-xs text-ink-muted">Файл дамжихгүй бол нэг мөр текстээр явах зүйл: «{result.payload.fallbackText}»</p>
              )}
            </>
          ) : (
            <Alert tone="info">Илгээх бэлтгэл хийгдсэнгүй, учир нь: {result.outcome.reason ?? result.outcome.status}.</Alert>
          )}
        </Card>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => (busy ? undefined : setConfirmOpen(false))}
        title="Туршилтын PDF илгээх үү?"
        description="Зөвхөн баталгаажсан нэг туршигчид, нэг файл ба нэг текст илгээнэ."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy !== null}>Цуцлах</Button>
            <Button onClick={() => void run(false)} loading={busy === "real"}>Илгээх</Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">Үйлдлийг буцаах боломжгүй. Жинхэнэ хэрэглэгчид энэ замаар хэзээ ч мессеж очихгүй.</p>
      </Modal>
    </div>
  );
}
