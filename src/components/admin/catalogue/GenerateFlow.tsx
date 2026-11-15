import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, Modal, Select, cx, useToast } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import { formatBytes } from "@/lib/adminUtils";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import type { CatalogueVersionView } from "@/lib/catalogue/admin/types";
import { selectionBounds } from "@/lib/catalogue/admin/validation";
import type { GenerateSummary } from "./api";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { PagePreview } from "./PagePreview";
import { FileLinks } from "./VersionsPanel";
import { EDITION_LABEL, EditionPicker, SeverityChip, VersionStatusBadge, formatStamp } from "./shared";

type Step = "generate" | "preview" | "publish";

const STEPS: Array<{ key: Step; label: string }> = [
  { key: "generate", label: "1. Үүсгэх" },
  { key: "preview", label: "2. Урьдчилан харах" },
  { key: "publish", label: "3. Нийтлэх" },
];

/** Whole seconds since `startedAt` (null = not running), refreshed twice a second while running. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** Generate -> Preview -> Publish. Nothing leaves the building until the third step is confirmed. */
export function GenerateFlow({
  admin,
  focusVersionId,
  initialEdition = "quick",
  onPublished,
}: {
  admin: CatalogueAdmin;
  focusVersionId: string | null;
  initialEdition?: CatalogueEdition;
  onPublished: () => void;
}) {
  const toast = useToast();
  const { state, versions, api } = admin;
  const [step, setStep] = useState<Step>(focusVersionId ? "preview" : "generate");
  const [edition, setEdition] = useState<CatalogueEdition>(initialEdition);
  const [versionId, setVersionId] = useState<string | null>(focusVersionId);
  const [seenFocus, setSeenFocus] = useState<string | null>(focusVersionId);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const generating = startedAt !== null;
  const [genError, setGenError] = useState<string | null>(null);
  const [summary, setSummary] = useState<GenerateSummary | null>(null);
  // The acknowledgement and any publish error belong to ONE version: choosing another clears them.
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishFailure, setPublishFailure] = useState<{ versionId: string | null; message: string } | null>(null);
  const elapsed = useElapsed(startedAt);
  const acknowledged = acknowledgedFor !== null && acknowledgedFor === versionId;
  const publishError = publishFailure && publishFailure.versionId === versionId ? publishFailure.message : null;

  // A version picked in the history opens straight in the preview (adjusted during render, not in an effect).
  if (focusVersionId !== seenFocus) {
    setSeenFocus(focusVersionId);
    if (focusVersionId) {
      setVersionId(focusVersionId);
      setStep("preview");
    }
  }

  const version: CatalogueVersionView | null = useMemo(
    () => versions.find((candidate) => candidate.id === versionId) ?? null,
    [versions, versionId],
  );

  if (!state) return null;
  const selectedCount = state.config[edition].tripIds.length;
  const bounds = selectionBounds(edition);
  const selectionProblem =
    edition === "complete" ? null : selectedCount < bounds.min || selectedCount > bounds.max
      ? `${EDITION_LABEL[edition]}-д ${bounds.min}–${bounds.max} аялал сонгоно (одоо ${selectedCount}). «Сонголт» хэсгээс засна уу.`
      : null;
  const canGenerate = !generating && !selectionProblem;

  async function generate() {
    setStartedAt(Date.now());
    setGenError(null);
    setSummary(null);
    try {
      const result = await api.generate(edition);
      await admin.reload();
      setVersionId(result.version.id);
      setSummary(result.summary);
      toast.success(`v${result.version.versionNo} ноорог бэлэн боллоо.`);
      setStep("preview");
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Каталог үүсгэж чадсангүй.");
    } finally {
      setStartedAt(null);
    }
  }

  async function publish() {
    if (!version) return;
    setPublishing(true);
    setPublishFailure(null);
    try {
      await api.publish(version.id, acknowledged);
      toast.success(`v${version.versionNo} нийтлэгдлээ.`);
      setConfirmOpen(false);
      await admin.reload();
      onPublished();
    } catch (err) {
      setConfirmOpen(false);
      setPublishFailure({ versionId: version.id, message: err instanceof Error ? err.message : "Нийтэлж чадсангүй." });
    } finally {
      setPublishing(false);
    }
  }

  const blocking = version?.warnings.filter((w) => w.severity === "blocking") ?? [];
  const otherWarnings = version?.warnings.filter((w) => w.severity !== "blocking") ?? [];
  const publishable = version !== null && version.status === "draft" && version.edition !== "preview";
  const quickLimits = selectionBounds("quick");
  const quickBounds = version?.edition === "quick" && (version.tripCount < quickLimits.min || version.tripCount > quickLimits.max);
  const canPublish = publishable && !quickBounds && (blocking.length === 0 || acknowledged);

  return (
    <div className="space-y-5">
      <nav aria-label="Алхам">
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((entry) => {
            const disabled = entry.key !== "generate" && !version;
            const active = entry.key === step;
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-current={active ? "step" : undefined}
                  onClick={() => setStep(entry.key)}
                  className={cx(
                    "min-h-10 rounded-lg border px-4 text-[13px] font-semibold transition-colors focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50",
                    active ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface text-ink-muted hover:text-ink",
                  )}
                >
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === "generate" && (
        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold text-ink">Шинэ каталог үүсгэх</h2>
          <p className="max-w-2xl text-sm text-ink-muted">
            Аяллын сангаас нэг дор агшин авч, түүнээс PDF болон хуудсын зургийг нэг дор үүсгэнэ. Үүссэн файл ноорог хэвээр байна: нийтлэх хүртэл хэн ч хүлээж авахгүй.
          </p>
          <EditionPicker legend="Төрөл" name="generate-edition" value={edition} onChange={setEdition} editions={["quick", "complete", "preview"]} />
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">Сонгосон аялал</dt>
              <dd className="mt-1 text-sm text-ink">{edition === "complete" ? "Бүх тохирох аялал автоматаар" : `${selectedCount} (зөвшөөрөгдөх ${bounds.min}–${bounds.max})`}</dd>
            </div>
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">PDF хөтөч</dt>
              <dd className="mt-1 text-sm text-ink">Үүсгэх үед шалгагдана</dd>
            </div>
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">Өгөгдлийн огноо</dt>
              <dd className="mt-1 text-sm text-ink">{state.today}</dd>
            </div>
          </dl>
          {selectionProblem && <Alert tone="warning">{selectionProblem}</Alert>}
          {genError && <Alert tone="danger">{genError}</Alert>}
          {generating && (
            <div role="status" aria-live="polite" aria-busy="true" className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
              </div>
              <p className="text-sm text-ink-muted">Үүсгэж байна… {elapsed} сек. Зураг боловсруулж, PDF болгоход 20–60 секунд болно. Хуудсыг хаахгүй байна уу.</p>
            </div>
          )}
          <div>
            <Button onClick={() => void generate()} disabled={!canGenerate} loading={generating}>
              <Icons.play size={14} />
              {generating ? "Үүсгэж байна" : "Үүсгэх"}
            </Button>
          </div>
          {summary && !generating && (
            <p className="text-xs text-ink-muted">Сүүлийн үүсгэлт: {summary.pages} хуудас · {formatBytes(summary.sizeBytes)} · {summary.trips} аялал · {(summary.durationMs / 1000).toFixed(1)} сек.</p>
          )}
        </Card>
      )}

      {step !== "generate" && (
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <Select label="Хувилбар" value={versionId ?? ""} onChange={(event) => setVersionId(event.target.value || null)}>
                <option value="">Хувилбар сонгоно уу</option>
                {versions.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {`v${candidate.versionNo} · ${EDITION_LABEL[candidate.edition]} · ${candidate.status === "draft" ? "ноорог" : candidate.status === "published" ? "нийтлэгдсэн" : "хуучирсан"} · ${formatStamp(candidate.generatedAt)}`}
                  </option>
                ))}
              </Select>
            </div>
            {version && <FileLinks version={version} />}
          </div>
        </Card>
      )}

      {step === "preview" && (version ? <PagePreview key={version.id} version={version} /> : <EmptyState icon={<Icons.image size={20} />} title="Хувилбар сонгоогүй байна" description="Дээрээс хувилбар сонгох эсвэл шинээр үүсгэнэ үү." />)}

      {step === "publish" && (
        version ? (
          <Card className="space-y-4 p-5">
            <SectionHeading
              title={`v${version.versionNo} · ${EDITION_LABEL[version.edition]}`}
              description={`${version.pageCount} хуудас · ${formatBytes(version.sizeBytes)} · ${version.tripCount} аялал · үүссэн ${formatStamp(version.generatedAt)}`}
              action={<VersionStatusBadge status={version.status} />}
            />
            {version.edition === "preview" && <Alert tone="info">Дээж хувилбарыг нийтэлдэггүй: зөвхөн дизайн шалгахад ашиглана.</Alert>}
            {version.status === "published" && <Alert tone="success">Энэ хувилбар аль хэдийн нийтлэгдсэн байна.</Alert>}
            {version.status === "superseded" && <Alert tone="info">Энэ хувилбар хуучирсан. Дахин хэрэглэхийг хүсвэл «Хувилбар» хэсгээс «Буцаах» дарна.</Alert>}
            {quickBounds && <Alert tone="danger">Хурдан каталог {quickLimits.min}–{quickLimits.max} аялалтай байх ёстой тул энэ ноорогийг нийтэлж болохгүй.</Alert>}

            <div>
              <h3 className="text-sm font-semibold text-ink">Анхааруулга</h3>
              {version.warnings.length === 0 ? (
                <p className="mt-1 text-sm text-ink-muted">Анхааруулга алга.</p>
              ) : (
                <ul className="mt-2 space-y-2" aria-label="Анхааруулгууд">
                  {[...blocking, ...otherWarnings].map((warning, index) => (
                    <li key={`${warning.code}-${index}`} className="flex items-start gap-2 text-sm text-ink">
                      <SeverityChip severity={warning.severity} className="shrink-0" />
                      <span>{warning.message}{warning.tripId ? <span className="text-xs text-ink-muted"> · {warning.tripId}</span> : null}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {publishable && blocking.length > 0 && (
              <label className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-ink">
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledgedFor(event.target.checked ? version.id : null)} className="mt-0.5 h-4 w-4" />
                <span>Дээрх {blocking.length} хориглосон анхааруулгыг уншсан. Тэдгээртэй хэвээр нийтлэхийг ойлгож байна.</span>
              </label>
            )}
            {publishError && <Alert tone="danger">{publishError}</Alert>}
            {publishable && (
              <div>
                <Button onClick={() => setConfirmOpen(true)} disabled={!canPublish}>
                  <Icons.send size={14} />
                  Нийтлэх
                </Button>
                {blocking.length > 0 && !acknowledged && <p className="mt-2 text-xs text-ink-muted">Хориглосон анхааруулгыг баталгаажуулахаас өмнө нийтэлж болохгүй.</p>}
              </div>
            )}
          </Card>
        ) : (
          <EmptyState icon={<Icons.file size={20} />} title="Хувилбар сонгоогүй байна" description="Дээрээс хувилбар сонгох эсвэл шинээр үүсгэнэ үү." />
        )
      )}

      <Modal
        open={confirmOpen}
        onClose={() => (publishing ? undefined : setConfirmOpen(false))}
        title="Энэ хувилбарыг нийтлэх үү?"
        description={version ? `${EDITION_LABEL[version.edition]} v${version.versionNo} дараагийн хүсэлтээс эхлэн хэрэглэгчид илгээгдэнэ.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={publishing}>Цуцлах</Button>
            <Button onClick={() => void publish()} loading={publishing}>Нийтлэх</Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-ink-muted">
          <p>Одоогийн нийтлэгдсэн хувилбар «хуучирсан» болно. Алдаа гарвал «Хувилбар» хэсгээс буцааж болно.</p>
          {blocking.length > 0 && <p className="font-semibold text-danger"><Badge tone="danger">{blocking.length}</Badge> хориглосон анхааруулгыг мэдсээр нийтэлж байна.</p>}
        </div>
      </Modal>
    </div>
  );
}
