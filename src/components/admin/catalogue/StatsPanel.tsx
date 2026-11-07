import { useCallback, useEffect, useState } from "react";
import { Alert, Card, EmptyState, Icons, Select } from "@/components/ui";
import { SectionHeading, StatCard } from "../AdminShared";
import type { CatalogueStatsResponse } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { EDITION_LABEL, formatStamp } from "./shared";
import type { CatalogueEdition } from "@/lib/catalogue/types";

/** Delivery results over the last days: counts only, no recipient data. */
export function StatsPanel({ admin }: { admin: CatalogueAdmin }) {
  const { api } = admin;
  const [days, setDays] = useState(14);
  const [stats, setStats] = useState<CatalogueStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await api.stats(days));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Статистикийг ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [api, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const delivered = stats ? stats.totals.sent + stats.totals.linkFallback : 0;
  const maxDay = Math.max(1, ...(stats?.byDay.map((day) => day.attempts) ?? [1]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading title="Илгээлтийн статистик" description="Зөвхөн тоо. Хэн рүү илгээснийг энд хадгалж, харуулахгүй." />
        <div className="w-40">
          <Select label="Хугацаа" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
            <option value="7">Сүүлийн 7 хоног</option>
            <option value="14">Сүүлийн 14 хоног</option>
          </Select>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {loading && !stats ? (
        <p role="status" className="py-10 text-center text-sm text-ink-muted">Статистик ачаалж байна…</p>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Хүргэгдсэн" value={delivered} tone="text-success" description={`${stats.totals.sent} файл · ${stats.totals.linkFallback} холбоос`} />
            <StatCard label="Амжилтгүй" value={stats.totals.failed} tone={stats.totals.failed ? "text-danger" : undefined} />
            <StatCard label="Давхардал саатуулсан" value={stats.totals.suppressedDuplicates} description="Дахин илгээгээгүй" />
            <StatCard label="Амжилтын хувь" value={stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`} description={`${stats.uniqueRecipients} өөр хүн`} />
          </div>
          <p className="text-xs text-ink-muted">
            Нийт оролдлого {stats.totals.attempts} · хуучирсан тул холбоос {stats.totals.staleFallback} · хаагдсан {stats.totals.blocked} · нийтлээгүй {stats.totals.noPublishedVersion} · дээж {stats.totals.dryRun}
            {stats.lastSentAt ? ` · сүүлд илгээсэн ${formatStamp(stats.lastSentAt)}` : ""}
          </p>

          {stats.totals.attempts === 0 ? (
            <EmptyState icon={<Icons.chart size={20} />} title="Энэ хугацаанд илгээлт алга" description="Хэрэглэгч каталог хүсэхэд энд тоо гарна." />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="overflow-hidden">
                <div className="overflow-x-auto" role="region" aria-label="Хувилбар тус бүрийн илгээлт" tabIndex={0}>
                  <table className="w-full min-w-[420px] text-left text-sm">
                    <caption className="sr-only">Хувилбар тус бүрийн илгээлтийн тоо</caption>
                    <thead className="bg-surface-sunken text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                      <tr>
                        <th scope="col" className="px-4 py-2.5">Хувилбар</th>
                        <th scope="col" className="px-3 py-2.5 text-right">Оролдлого</th>
                        <th scope="col" className="px-3 py-2.5 text-right">Хүргэгдсэн</th>
                        <th scope="col" className="px-3 py-2.5 text-right">Амжилтгүй</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {stats.byVersion.map((row) => (
                        <tr key={`${row.edition}-${row.versionId ?? "none"}`}>
                          <td className="px-4 py-3">
                            <span className="font-semibold text-ink">{row.versionNo ? `v${row.versionNo}` : "Хувилбаргүй"}</span>
                            <span className="block text-xs text-ink-muted">{EDITION_LABEL[row.edition as CatalogueEdition] ?? row.edition}</span>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{row.attempts}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-success">{row.delivered}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-danger">{row.failed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card className="p-4">
                <h3 className="text-sm font-semibold text-ink">Өдөр тутмын оролдлого</h3>
                <ul className="mt-3 space-y-2" aria-label="Өдөр тутмын илгээлт">
                  {stats.byDay.map((day) => (
                    <li key={day.day} className="grid grid-cols-[84px_1fr_auto] items-center gap-3 text-xs">
                      <span className="tabular-nums text-ink-muted">{day.day}</span>
                      <span className="h-2.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(4, Math.round((day.attempts / maxDay) * 100))}%` }} />
                      </span>
                      <span className="tabular-nums text-ink">{day.delivered}/{day.attempts}{day.failed ? <span className="text-danger"> · {day.failed} алдаа</span> : null}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
