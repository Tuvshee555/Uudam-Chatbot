import { useEffect, useState } from "react";
import { Icons } from "@/components/ui";

const CHECK_EVERY_MS = 5 * 60 * 1000;

/**
 * Says when a newer admin has been deployed than the one this tab is running.
 * A tab left open keeps the code it loaded: on 2026-11-05 the owner judged a
 * rebuilt screen by a tab opened before the deploy, and saw only the old one.
 */
export function NewVersionBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const running = (window as unknown as { __NEXT_DATA__?: { buildId?: string } }).__NEXT_DATA__?.buildId;
    if (!running || running === "development") return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const html = await (await fetch(window.location.pathname, { cache: "no-store", credentials: "same-origin" })).text();
        const live = /"buildId":"([^"]+)"/.exec(html)?.[1];
        if (live && live !== running && !stopped) setStale(true);
      } catch { /* offline: the next check retries */ }
    };
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);

  if (!stale) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-[min(36rem,calc(100%-2rem))] items-center gap-3 rounded-xl border border-brand-border bg-surface px-4 py-3 shadow-lg">
      <Icons.refresh size={16} className="shrink-0 text-brand" />
      <p className="min-w-0 flex-1 text-sm leading-5 text-ink">
        Админы шинэ хувилбар гарсан. Дахин ачаалбал шинэ хувилбар нээгдэнэ.
        <span className="block text-xs text-ink-muted">Хадгалаагүй санал байвал эхлээд хадгална уу.</span>
      </p>
      <button type="button" onClick={() => window.location.reload()}
        className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-hover">
        Дахин ачаалах
      </button>
    </div>
  );
}
