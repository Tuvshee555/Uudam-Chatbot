import { useState } from "react";
import { Alert, Badge, Button, Card, Modal, Select, useToast } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import { formatBytes } from "@/lib/adminUtils";
import type { CatalogueTestSendResponse } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { EDITION_LABEL, formatStamp } from "./shared";
import { TesterPairing } from "./TesterPairing";
import { TEST_READINESS_TEXT, testReadiness } from "./pairingFlow";

const OUTCOME_LABEL: Record<string, string> = {
  dry_run: "Дээж: илгээгээгүй",
  sent: "Илгээгдлээ",
  sent_link_fallback: "Файл биш, холбоосоор илгээгдлээ",
  stale_fallback: "Хуучирсан тул зөвхөн холбоос явлаа",
  duplicate_suppressed: "Давхардал тул илгээгээгүй",
  blocked_staff_owned: "Ажилтан яриаг эзэмшсэн тул илгээгээгүй",
  blocked_paused: "Бот түр зогссон тул илгээгээгүй",
  blocked_window: "24 цагийн цонх хаагдсан тул илгээгээгүй: та Page руу дахин бичнэ үү",
  blocked_killswitch: "Meta руу илгээх унтраалттай тул илгээгээгүй",
  no_published_version: "Нийтлэгдсэн хувилбар алга",
  failed: "Амжилтгүй",
};

/**
 * «Туршилтын илгээлт»: two steps. 1) connect your Messenger once (code + three steps, then it pairs by itself);
 * 2) press «Тест илгээх» for the chosen file. The preview of what would be sent stays one click away and sends
 * nothing. A real send reaches only a tester who proved the account with the code, and still asks before it goes.
 */
export function TestSendPanel({ admin }: { admin: CatalogueAdmin }) {
  const toast = useToast();
  const { state, api } = admin;
  // "published:quick" | "published:complete" | "version:<id>" (a draft can be tested before it is published)
  const [target, setTarget] = useState("published:quick");
  // "tester:<id>" | "env:<ref>" | "" (first reachable). A freshly paired tester is selected automatically.
  const [recipient, setRecipient] = useState("");
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

  // Everything that can receive a real send, newest paired first (the list is newest first).
  const options = [
    ...testSend.testers.map((tester) => ({ value: `tester:${tester.id}`, label: `${tester.label || "Миний Messenger"} ${tester.masked}${tester.windowOpen ? "" : " (цонх хаагдсан)"}`, usable: tester.windowOpen })),
    ...testSend.recipients.map((entry) => ({ value: `env:${entry.ref}`, label: `Туршигч ${entry.label}`, usable: true })),
  ];
  const chosen = options.find((option) => option.value === recipient) ?? options.find((option) => option.usable) ?? options[0] ?? null;
  const recipientArgs = chosen
    ? chosen.value.startsWith("tester:") ? { testerId: chosen.value.slice(7) } : { recipientRef: chosen.value.slice(4) }
    : {};
  const selectedTesterId = chosen?.value.startsWith("tester:") ? chosen.value.slice(7) : null;
  const readiness = testReadiness({ testers: testSend.testers, selectedId: recipient.startsWith("tester:") ? recipient.slice(7) : selectedTesterId, metaOutboundDisabled: testSend.metaOutboundDisabled });
  const envReady = chosen?.value.startsWith("env:") === true && !testSend.metaOutboundDisabled;
  const canSendReal = (readiness.kind === "ready" || envReady) && testSend.realSendPossible && Boolean(chosen?.usable) && Boolean(file);
  const blockedText = canSendReal
    ? null
    : !file
      ? "Нийтлэгдсэн хувилбар алга. Дээрээс ноорог хувилбарыг сонгож туршиж болно, эсвэл эхлээд нийтэлнэ үү."
      : readiness.kind === "ready" || envReady
        ? testSend.blockedReason
        : TEST_READINESS_TEXT[readiness.kind];

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
      if (!dryRun) toast.success(response.outcome.status === "sent" ? "Туршилтын PDF илгээгдлээ. Messenger-ээ нээгээд харна уу." : OUTCOME_LABEL[response.outcome.status] ?? response.outcome.status);
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
        description="Жинхэнэ хэрэглэгчид хэзээ ч очихгүй. Эхлээд өөрийн Messenger-ээ нэг удаа холбоод, дараа нь файлаа утсандаа илгээж харна."
      />
      <TesterPairing
        admin={admin}
        selectedTesterId={selectedTesterId}
        onPaired={(testerId) => setRecipient(`tester:${testerId}`)}
        onRevoked={(testerId) => setRecipient((current) => (current === `tester:${testerId}` ? "" : current))}
      />

      <Card className="space-y-4 p-5">
        <h3 className="text-base font-semibold text-ink">2. Тест илгээх</h3>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <Select label="Аль файлыг" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="published:quick">Нийтлэгдсэн · {EDITION_LABEL.quick}</option>
            <option value="published:complete">Нийтлэгдсэн · {EDITION_LABEL.complete}</option>
            {testable.map((candidate) => (
              <option key={candidate.id} value={`version:${candidate.id}`}>
                {`v${candidate.versionNo} · ${EDITION_LABEL[candidate.edition]} · ${candidate.status === "draft" ? "ноорог" : "нийтлэгдсэн"} · ${formatStamp(candidate.generatedAt)}`}
              </option>
            ))}
          </Select>
          {options.length > 1 && (
            <Select label="Хэнд" value={chosen?.value ?? ""} onChange={(event) => setRecipient(event.target.value)}>
              {options.map((option) => (
                <option key={option.value} value={option.value} disabled={!option.usable}>{option.label}</option>
              ))}
            </Select>
          )}
        </div>

        {!file ? (
          <Alert tone="info">{EDITION_LABEL[publishedEdition]}-ийн нийтлэгдсэн хувилбар алга. Ноорог хувилбарыг дээрээс сонгож туршиж болно, эсвэл эхлээд нийтэлнэ үү.</Alert>
        ) : (
          <p className="text-sm text-ink-muted">
            Илгээгдэх файл: <span className="font-semibold text-ink">{file.fileName}</span> · v{file.versionNo} · {formatBytes(file.sizeBytes)} · {file.pageCount} хуудас · {file.status === "draft" ? "ноорог (нийтлээгүй)" : `нийтэлсэн ${formatStamp(file.publishedAt)}`}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={() => setConfirmOpen(true)} disabled={!canSendReal || busy !== null}>
            Тест илгээх
          </Button>
          <Button variant="ghost" onClick={() => void run(true)} loading={busy === "dry"} disabled={!file || busy !== null}>
            Дээж харах (илгээхгүй)
          </Button>
          <Badge tone={canSendReal ? "success" : "neutral"} dot>{canSendReal ? "Илгээхэд бэлэн" : "Одоогоор илгээх боломжгүй"}</Badge>
        </div>
        {blockedText && <Alert tone="info">{blockedText}</Alert>}
      </Card>

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
                Хүлээн авагч: {result.tester ? `${result.tester.label || "Миний Messenger"} ${result.tester.masked}` : result.payload.recipient} · Файл: {result.payload.file.name} ({formatBytes(result.payload.file.sizeBytes)}{result.payload.file.pages ? `, ${result.payload.file.pages} хуудас` : ""}) · {result.payload.attachmentSource === "cached_attachment_id" ? "Өмнө нь байршсан файлыг дахин ашиглана" : "Илгээх үед байршуулна"}
              </p>
              <details className="text-sm">
                <summary className="cursor-pointer font-semibold text-ink">Яг юу явах вэ ({result.payload.messages.length} мессеж: 1 текст, 1 файл)</summary>
                <ol className="mt-3 space-y-3" aria-label="Явах мессежүүд">
                  {result.payload.messages.map((message, index) => (
                    <li key={`${message.kind}-${index}`}>
                      <p className="mb-1 text-xs font-semibold text-ink">{index + 1}. {message.kind === "file" ? "Файл хавсралт" : "Текст"}</p>
                      <pre
                        tabIndex={0}
                        aria-label={`Мессеж ${index + 1}`}
                        className="max-h-[260px] overflow-auto rounded-lg bg-surface-sunken p-3 text-xs leading-5 text-ink"
                      >
                        {JSON.stringify(message.body, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ol>
              </details>
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
        title="Туршилтын PDF-г утас руугаа илгээх үү?"
        description={`${chosen?.label ?? "Тестер"}: нэг файл, нэг товч текст.`}
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
