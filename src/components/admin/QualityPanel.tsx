import { useEffect, useState } from "react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui";
import { StatCard } from "./AdminShared";
import { QUALITY_DAYS, silentReasonLabel, type DeliveryQuality } from "@/lib/deliveryQuality";
import { formatTime } from "@/lib/adminUtils";

const number = (value: number) => value.toLocaleString("mn-MN");
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

/**
 * What happened to each incoming message (real customers only; test sessions and local
 * runs excluded), from the per-message delivery records. These are MESSAGE counts over
 * the fixed last 7 days, or since the records began if that is later; the KPI row above
 * counts PEOPLE over the selected period. Labels say which, so the two never read as
 * conflicting "answered" numbers.
 * "Баталгаат" = a count of stored records; "Тооцоо" = derived from them.
 */
export function QualityPanel({ apiFetch }: { apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [quality, setQuality] = useState<DeliveryQuality | null>(null);
  const [failed, setFailed] = useState(false);
  // Whether the records started after the 7-day window opened (decided when they arrive).
  const [partialWindow, setPartialWindow] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/admin/quality", { signal: controller.signal })
      .then(async (response) => {
        const json = await response.json().catch(() => null) as { ok?: boolean; quality?: DeliveryQuality } | null;
        if (!response.ok || !json?.quality) throw new Error("quality_unavailable");
        const since = json.quality.trailSince ? Date.parse(json.quality.trailSince) : NaN;
        setPartialWindow(Number.isFinite(since) && since - (Date.now() - QUALITY_DAYS * 86_400_000) > 6 * 3_600_000);
        setQuality(json.quality);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [apiFetch]);

  if (failed) return <Alert tone="warning">Мессежийн хүргэлтийн тоймыг ачаалж чадсангүй.</Alert>;
  if (!quality) return <Skeleton className="h-40 rounded-xl" />;
  const { trail, leads } = quality;
  const outcomes = trail.answered + trail.silent + trail.storedNoReply + trail.notStored + trail.failed;
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-ink">
            Мессежийн хүргэлт · {partialWindow ? `${formatTime(quality.trailSince)}-аас хойш` : `сүүлийн ${QUALITY_DAYS} хоног`}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Ирсэн мессеж бүр юу болсон бэ. Тоо нь мессежээр (хүнээр биш), зөвхөн жинхэнэ хэрэглэгчийнх.
            {!quality.trailSince && " Мессеж бүрийн бүртгэл одоогоор алга."}
          </p>
        </div>
        <Badge tone="neutral">Баталгаат = бүртгэлийн тоо · Тооцоо = тэдгээрээс гаргасан</Badge>
      </div>
      {quality.droppedLogRecords > 0 && (
        <Alert tone="warning">Ачаалал ихтэй үед {number(quality.droppedLogRecords)} бүртгэл хадгалагдаагүй тул доорх тоо дутуу байж болно.</Alert>
      )}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label="Ирсэн мессеж" value={number(quality.customers.inboundMessages)}
          description={`Баталгаат · ${number(quality.customers.wrote)} хэрэглэгчээс`} />
        <StatCard label="Хариулсан мессеж" value={number(trail.answered)} tone="text-success"
          description={`Баталгаат · үр дүнтэйн ${share(trail.answered, outcomes)} (тооцоо)`} />
        <StatCard label="Зориуд хариулаагүй" value={number(trail.silent)} description="Баталгаат мессеж · шалтгааныг доор" />
        <StatCard label="Алдаатай мессеж" value={number(trail.failed)} tone={trail.failed ? "text-danger" : undefined}
          description={`Баталгаат · давтагдсан ${number(trail.repeatedFailures)}`} />
        <StatCard label="Ажилтан хүлээж буй" value={number(leads.attention.needsAttention)} tone={leads.attention.waiting ? "text-danger" : undefined}
          description={`Хүсэлт · ${number(leads.attention.waiting)} нь хариу хүлээж байна`} />
        <StatCard label="Давхар ирсэн мессеж" value={number(trail.duplicateDeliveries)} description="Баталгаат · Meta дахин илгээсэн, алгассан" />
        <StatCard label="Үр дүн бүртгэгдээгүй" value={number(trail.withoutOutcome)} tone={trail.withoutOutcome ? "text-warning" : undefined}
          description="Тооцоо · боловсруулж буй эсвэл бүртгэл алга" />
      </div>
      {(trail.silentReasons.length > 0 || trail.failureReasons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {trail.silentReasons.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink">Хариулаагүй шалтгаан (мессеж)</p>
              <ul className="space-y-1 text-sm text-ink-muted">
                {trail.silentReasons.slice(0, 6).map((row) => (
                  <li key={row.reason} className="flex justify-between gap-3"><span>{silentReasonLabel(row.reason)}</span><span className="tabular-nums">{number(row.count)}</span></li>
                ))}
              </ul>
            </div>
          )}
          {trail.failureReasons.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink">Алдааны шалтгаан (мессеж)</p>
              <ul className="space-y-1 text-sm text-ink-muted">
                {trail.failureReasons.slice(0, 6).map((row) => (
                  <li key={row.reason} className="flex justify-between gap-3">
                    <span>{row.reason === "delivery_failed" ? "Meta хариуг хүлээж аваагүй" : row.reason}</span>
                    <span className="tabular-nums">{number(row.count)}</span>
                  </li>
                ))}
              </ul>
              {trail.preservedAfterFailures > 0 && (
                <p className="mt-1.5 text-xs text-ink-muted">{number(trail.preservedAfterFailures)} мессежийг олон удаа амжилтгүй болсны дараа хадгалж, ажилтанд шилжүүлсэн.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
