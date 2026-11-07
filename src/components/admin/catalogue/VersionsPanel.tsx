import { useState, type ReactNode } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, Modal, cx, useToast } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import { formatBytes } from "@/lib/adminUtils";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import type { CatalogueEditionState, CatalogueVersionView } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { EDITION_LABEL, FreshnessBadge, VersionStatusBadge, formatStamp } from "./shared";

const LINK_BUTTON =
  "inline-flex min-h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-sunken focus-visible:outline-brand";

export function FileLinks({ version, compact = false }: { version: CatalogueVersionView; compact?: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-2">
      <a className={LINK_BUTTON} href={version.openPath} target="_blank" rel="noopener noreferrer" aria-label={`${version.fileName} нээх`}>
        <Icons.file size={14} />
        {compact ? "Нээх" : "PDF нээх"}
      </a>
      <a className={LINK_BUTTON} href={version.downloadPath} download={version.fileName} aria-label={`${version.fileName} татах`}>
        <Icons.download size={14} />
        Татах
      </a>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function PublishedCard({ edition, info, onGenerate }: { edition: "quick" | "complete"; info: CatalogueEditionState; onGenerate: (edition: CatalogueEdition) => void }) {
  const published = info.published;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{EDITION_LABEL[edition]}</h3>
          <p className="mt-0.5 text-xs text-ink-muted">Хэрэглэгчид одоо илгээгдэж буй хувилбар</p>
        </div>
        <FreshnessBadge freshness={info.freshness} />
      </div>

      {info.freshness.status === "stale" && (
        <Alert tone="warning">
          <span className="font-semibold">Энэ хувилбар хуучирсан.</span>
          <ul className="mt-1 list-disc pl-5">
            {info.freshness.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <span className="mt-1 block">
            Хуучирсан файлыг бот хэрэглэгчид илгээхгүй: зөвхөн сайтын холбоос бүхий нэг мөр хариу өгч, ажилтанд хүсэлтийг үлдээнэ.
            Шинээр үүсгээд нийтэлнэ үү.
          </span>
        </Alert>
      )}
      {info.freshness.status === "unknown" && (
        <Alert tone="info">Одоогийн аяллын мэдээлэлтэй харьцуулж чадсангүй: {info.freshness.reasons.join(" ") || "дараа дахин оролдоно уу."}</Alert>
      )}

      {published ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Fact label="Файл">{published.fileName}</Fact>
            <Fact label="Хэмжээ">{formatBytes(published.sizeBytes)}</Fact>
            <Fact label="Хуудас">{published.pageCount}</Fact>
            <Fact label="Аялал">{published.tripCount}</Fact>
            <Fact label="Үүсгэсэн">
              {formatStamp(published.generatedAt)}
              {published.generatedBy ? <span className="block text-xs text-ink-muted">{published.generatedBy}</span> : null}
            </Fact>
            <Fact label="Нийтэлсэн">
              {formatStamp(published.publishedAt)}
              {published.publishedBy ? <span className="block text-xs text-ink-muted">{published.publishedBy}</span> : null}
            </Fact>
          </dl>
          {published.blockingCount + published.warningCount > 0 && (
            <p className="text-xs text-ink-muted">
              Нийтлэх үеийн анхааруулга: {published.blockingCount} хориглосон, {published.warningCount} энгийн.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <FileLinks version={published} />
            {published.publicPath && (
              <a
                className="text-[13px] font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-brand"
                href={`${origin}${published.publicPath}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Нийтийн холбоос
              </a>
            )}
          </div>
        </>
      ) : (
        <EmptyState
          icon={<Icons.file size={20} />}
          title="Нийтлэгдсэн хувилбар алга"
          description="Бот энэ каталогийг илгээж чадахгүй. Үүсгээд, урьдчилан хараад, нийтэлнэ үү."
          action={<Button size="sm" onClick={() => onGenerate(edition)}>Үүсгэх хэсэг рүү</Button>}
        />
      )}
      {info.latestDraft && (
        <p className="rounded-md bg-brand-soft px-3 py-2 text-xs text-brand">
          Нийтлээгүй ноорог байна: v{info.latestDraft.versionNo} · {formatStamp(info.latestDraft.generatedAt)}
        </p>
      )}
    </Card>
  );
}

export function VersionsPanel({
  admin,
  onPreview,
  onGenerate,
}: {
  admin: CatalogueAdmin;
  onPreview: (versionId: string) => void;
  onGenerate: (edition: CatalogueEdition) => void;
}) {
  const toast = useToast();
  const { state, versions, api } = admin;
  const [rollbackTarget, setRollbackTarget] = useState<CatalogueVersionView | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmRollback() {
    if (!rollbackTarget) return;
    setBusy(true);
    try {
      await api.rollback(rollbackTarget.id);
      toast.success(`v${rollbackTarget.versionNo} хувилбарыг дахин нийтэллээ.`);
      setRollbackTarget(null);
      await admin.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Буцааж чадсангүй.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <>
      <SectionHeading title="Нийтлэгдсэн хувилбарууд" description="Бот зөвхөн эдгээр файлыг хэрэглэгчид илгээнэ." />
      <div className="grid gap-4 lg:grid-cols-2">
        <PublishedCard edition="quick" info={state.editions.quick} onGenerate={onGenerate} />
        <PublishedCard edition="complete" info={state.editions.complete} onGenerate={onGenerate} />
      </div>

      <SectionHeading title="Хувилбарын түүх" description="Өмнө нийтлэгдэж байсан хувилбар руу буцаж болно. Файл хэзээ ч өөрчлөгддөггүй." />
      {versions.length === 0 ? (
        <EmptyState icon={<Icons.file size={20} />} title="Хувилбар үүсээгүй байна" description="Эхний каталогоо «Үүсгэх ба нийтлэх» хэсгээс үүсгэнэ." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto" role="region" aria-label="Хувилбарын түүх" tabIndex={0}>
            <table className="w-full min-w-[820px] text-left text-sm">
              <caption className="sr-only">Каталогийн бүх хувилбар, хамгийн сүүлийнх нь дээр</caption>
              <thead className="bg-surface-sunken text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5">Хувилбар</th>
                  <th scope="col" className="px-3 py-2.5">Төлөв</th>
                  <th scope="col" className="px-3 py-2.5">Файл</th>
                  <th scope="col" className="px-3 py-2.5">Хэмжээ</th>
                  <th scope="col" className="px-3 py-2.5">Үүсгэсэн</th>
                  <th scope="col" className="px-3 py-2.5">Нийтэлсэн</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Үйлдэл</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {versions.map((version) => (
                  <tr key={version.id} className={cx(version.status === "published" && "bg-success-soft/40")}>
                    <td className="px-4 py-3 align-top">
                      <span className="font-semibold text-ink">v{version.versionNo}</span>
                      <span className="block text-xs text-ink-muted">{EDITION_LABEL[version.edition]}</span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <VersionStatusBadge status={version.status} />
                      {version.blockingCount > 0 && <Badge tone="danger" className="ml-1">{version.blockingCount} хориг</Badge>}
                    </td>
                    <td className="max-w-[240px] break-words px-3 py-3 align-top text-xs text-ink">
                      {version.fileName}
                      <span className="block text-ink-muted">{version.pageCount} хуудас · {version.tripCount} аялал</span>
                    </td>
                    <td className="px-3 py-3 align-top tabular-nums">{formatBytes(version.sizeBytes)}</td>
                    <td className="px-3 py-3 align-top text-xs">
                      {formatStamp(version.generatedAt)}
                      <span className="block text-ink-muted">{version.generatedBy ?? "—"}</span>
                    </td>
                    <td className="px-3 py-3 align-top text-xs">
                      {formatStamp(version.publishedAt)}
                      <span className="block text-ink-muted">{version.publishedBy ?? "—"}</span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => onPreview(version.id)} aria-label={`v${version.versionNo} хуудсаар нь харах`}>
                          Харах
                        </Button>
                        <FileLinks version={version} compact />
                        {version.status === "superseded" && version.edition !== "preview" && (
                          <Button size="sm" variant="secondary" onClick={() => setRollbackTarget(version)} aria-label={`v${version.versionNo} руу буцах`}>
                            Буцаах
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={rollbackTarget !== null}
        onClose={() => (busy ? undefined : setRollbackTarget(null))}
        title="Өмнөх хувилбар руу буцаах уу?"
        description={
          rollbackTarget
            ? `${EDITION_LABEL[rollbackTarget.edition]}: v${rollbackTarget.versionNo} (${formatStamp(rollbackTarget.generatedAt)}) дахин хэрэглэгчид илгээгдэх хувилбар болно. Одоогийн нийтлэгдсэн хувилбар «хуучирсан» төлөвт орно.`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setRollbackTarget(null)} disabled={busy}>Цуцлах</Button>
            <Button onClick={() => void confirmRollback()} loading={busy}>Буцаах</Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Буцаасан хувилбарын үнэ, огноо тэр үеийнх хэвээр байна. Хэрэв аяллын мэдээлэл өөрчлөгдсөн бол хуучирсан гэж тэмдэглэгдэнэ.
        </p>
      </Modal>
    </>
  );
}
