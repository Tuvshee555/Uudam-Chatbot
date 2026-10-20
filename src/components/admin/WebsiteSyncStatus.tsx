import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Icons, Spinner } from "@/components/ui";
import { BOOKING_WEBSITE_URL } from "@/lib/bookingWebsite";
import { formatTime } from "@/lib/adminUtils";
import { hasWebsiteSyncConflict, parseWebsiteSyncStatus, summarizeWebsiteSync } from "@/lib/websiteSyncStatus";

export function WebsiteSyncStatus({ apiFetch, onReviewTrip }: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onReviewTrip?: (tripId: string) => void | Promise<void>;
}) {
  const [state, setState] = useState<NonNullable<ReturnType<typeof parseWebsiteSyncStatus>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewingId, setReviewingId] = useState("");
  const requestRef = useRef(0);
  const busyRef = useRef(false);

  const refresh = useCallback(async (method: "GET" | "POST" = "GET") => {
    if (busyRef.current) return;
    const request = ++requestRef.current;
    if (method === "POST") { busyRef.current = true; setBusy(true); }
    try {
      const response = await apiFetch("/api/admin/website-sync", { method });
      if (!response.ok) throw new Error("unavailable");
      const next = parseWebsiteSyncStatus(await response.json());
      if (!next) throw new Error("invalid_response");
      if (request === requestRef.current) { setState(next); setError(""); }
    } catch {
      if (request === requestRef.current) setError("Холболтын төлөвийг авч чадсангүй. Дахин шалгаарай.");
    } finally {
      if (method === "POST") { busyRef.current = false; setBusy(false); }
    }
  }, [apiFetch]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => { window.clearInterval(timer); requestRef.current += 1; };
  }, [refresh]);

  const summary = summarizeWebsiteSync(state?.trips || []);
  const issues = state?.trips.filter(row => !row.synced || row.last_error || hasWebsiteSyncConflict(row)) || [];
  const message = error || (!state ? "Холболтын төлөв шалгаж байна…" : !state.configured
    ? "Вэбсайтын холболт тохируулаагүй байна."
    : summary.pending ? `${summary.pending} аяллын өөрчлөлт вэбсайт руу хүрэхээр хүлээгдэж байна.`
    : summary.failed ? `${summary.failed} аяллын сүүлийн алдааг дахин шалгах шаардлагатай.`
    : summary.conflicts ? `${summary.conflicts} аяллын мэдээллийг хоёр талд нь харьцуулж хянах шаардлагатай.`
    : !summary.total ? "Холбосон аяллын мэдээлэл хараахан алга."
    : "Вэбсайт руу бүх өөрчлөлт хүргэгдсэн.");

  return (
    <section className="my-4 rounded-xl border border-line bg-canvas/60 p-4" aria-label="Вэбсайтын холболт">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-52">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Icons.refresh size={16} className="text-brand" />Вэбсайттай холболт</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted" role="status">{message}</p>
          {state?.configured && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Badge tone="neutral">{summary.total} холбосон аялал</Badge>
              {summary.pending > 0 && <Badge tone="warning">{summary.pending} хүлээгдэж буй</Badge>}
              {summary.failed > 0 && <Badge tone="danger">{summary.failed} хүргэсэнгүй</Badge>}
              {summary.conflicts > 0 && <Badge tone="warning">{summary.conflicts} хянах</Badge>}
            </div>
          )}
        </div>
        <Button size="sm" variant="secondary" loading={busy} disabled={busy}
          onClick={() => void refresh(state?.configured ? "POST" : "GET")}>
          <Icons.refresh size={14} />{state?.configured ? "Дахин шинэчлэх" : "Төлөв шалгах"}
        </Button>
      </div>
      {summary.lastSyncedAt && <p className="mt-3 text-xs text-ink-muted">Сүүлд хүргэсэн: {formatTime(summary.lastSyncedAt)}</p>}
      {issues.length > 0 && state?.configured && (
        <details className="mt-3 border-t border-line pt-3">
          <summary className="cursor-pointer rounded py-1 text-sm font-medium text-ink">Хүлээгдэж буй болон хянах аяллууд ({issues.length})</summary>
          <ul className="mt-2 divide-y divide-line">
            {issues.map(row => {
              const conflict = hasWebsiteSyncConflict(row);
              return (
                <li key={row.trip_id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-ink">{row.trip_name || "Холбосон аялал"}</p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                      {conflict ? "Хоёр талд өөрчлөгдсөн мэдээллийг харьцуулж хянаарай." : row.last_error
                        ? "Өөрчлөлтийг хүргэж чадсангүй. Дахин шинэчилж үзээрэй." : "Өөрчлөлтөө вэбсайт руу хүргэхээр хүлээж байна."}
                    </p>
                    {row.synced_at && <p className="mt-1 text-xs text-ink-muted">Сүүлд хүргэсэн: {formatTime(row.synced_at)}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {onReviewTrip && row.trip_status && (
                      <Button size="sm" variant="secondary" disabled={Boolean(reviewingId)} onClick={async () => {
                        setReviewingId(row.trip_id);
                        try { await onReviewTrip(row.trip_id); } finally { setReviewingId(""); }
                      }}>
                        {reviewingId === row.trip_id && <Spinner />}Аяллыг хянах
                      </Button>
                    )}
                    {row.website_slug && <a href={`${BOOKING_WEBSITE_URL}/trips/${encodeURIComponent(row.website_slug)}`} target="_blank" rel="noopener noreferrer"
                      className="inline-flex min-h-10 items-center rounded-md px-2 text-sm font-medium text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand">Вэб дээр нээх</a>}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
