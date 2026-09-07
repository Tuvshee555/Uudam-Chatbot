import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";

type SyncRow = { trip_id: string; synced: boolean; last_error: string | null; website_slug: string | null };
export function WebsiteSyncStatus({ apiFetch }: { apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [state, setState] = useState<{ configured: boolean; trips: SyncRow[] }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (method = "GET") => {
    try {
      const res = await apiFetch("/api/admin/website-sync", { method });
      if (!res.ok) throw new Error("Холболтын төлөвийг авч чадсангүй");
      setState(await res.json());
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Холболтын алдаа"); }
  }, [apiFetch]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(),15000); return () => clearInterval(timer); }, [refresh]);
  const pending = state?.trips.filter(t => !t.synced) || [];
  return <div className="my-3 border-y border-line py-3 text-sm" role="status">
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* The queue only holds trips changed since the last delivery, so its row
          count is not the catalogue size — reporting one as the other read as
          "0 trips connected" while every trip was in fact live on the website. */}
      <span>{error || (!state ? "Вэбсайтын холболт шалгаж байна…" : !state.configured ? "Вэбсайтын холболт тохируулаагүй" :
        pending.length ? `Вэбсайт руу шинэчлэх ${pending.length} аялал байна` : "Вэбсайт руу бүх өөрчлөлт хүргэгдсэн")}</span>
      <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); await refresh("POST"); setBusy(false); }}>Дахин шинэчлэх</Button>
    </div>
    {pending.map(row => <p key={row.trip_id} className="mt-1 break-words text-danger">{row.trip_id}: {row.last_error || "Шинэчилж байна"}</p>)}
  </div>;
}
