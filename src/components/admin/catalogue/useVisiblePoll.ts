import { useEffect, useRef } from "react";

/**
 * Runs `task` every `intervalMs` while `active`, skipping ticks while the browser tab is hidden and running it at once
 * when the tab comes back. Never overlaps two runs, stops on unmount and when `active` turns false, and swallows task
 * errors (the next tick simply tries again).
 */
export function useVisiblePoll(task: () => Promise<void> | void, intervalMs: number, active: boolean): void {
  const latest = useRef(task);
  useEffect(() => {
    latest.current = task;
  });

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let running = false;
    const run = async () => {
      if (stopped || running || (typeof document !== "undefined" && document.hidden)) return;
      running = true;
      try {
        await latest.current();
      } catch {
        // Try again on the next tick.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void run(), intervalMs);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) void run();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs]);
}
