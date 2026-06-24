import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Icons, Spinner, cx } from "@/components/ui";
import { SectionHeading } from "./AdminShared";

type Props = {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
};

type SaveResult = { saved: number; failed: number; errors: string[] };

export function JsonEditorTab({ apiFetch, onSaved }: Props) {
  const [json, setJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadTrips = useCallback(async () => {
    setLoading(true);
    setSaveResult(null);
    setParseError(null);
    try {
      const res = await apiFetch("/api/admin/trips-bulk");
      const data = await res.json() as { trips: unknown[] };
      setJson(JSON.stringify(data.trips, null, 2));
    } catch {
      setJson("// Татаж чадсангүй");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { void loadTrips(); }, [loadTrips]);

  function handleChange(value: string) {
    setJson(value);
    setParseError(null);
    setSaveResult(null);
  }

  async function handleSave() {
    setParseError(null);
    setSaveResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      setParseError(`JSON алдаа: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Accept either an array directly or { trips: [...] }
    const trips = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).trips))
        ? (parsed as Record<string, unknown>).trips as unknown[]
        : null;
    if (!trips) {
      setParseError("JSON нь array эсвэл { trips: [...] } хэлбэртэй байх ёстой.");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch("/api/admin/trips-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trips }),
      });
      const result = await res.json() as SaveResult;
      setSaveResult(result);
      if (result.saved > 0) onSaved();
    } catch (e) {
      setParseError(`Серверийн алдаа: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function handleFormat() {
    try {
      setJson(JSON.stringify(JSON.parse(json), null, 2));
      setParseError(null);
    } catch (e) {
      setParseError(`JSON алдаа: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(json);
  }

  const lineCount = json.split("\n").length;

  function tripCount() {
    try {
      const p = JSON.parse(json) as unknown;
      if (Array.isArray(p)) return p.length;
      if (p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).trips)) {
        return ((p as Record<string, unknown>).trips as unknown[]).length;
      }
    } catch { /* ignore */ }
    return null;
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionHeading
          title="JSON засварлагч"
          description="Бүх аяллын өгөгдлийг JSON хэлбэрээр харж, засварлаж, ChatGPT-ийн гаралтыг paste хийгээд хадгална уу."
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void loadTrips()} disabled={loading || saving}>
            <Icons.refresh size={14} />
            Дахин татах
          </Button>
          <Button size="sm" variant="secondary" onClick={handleFormat} disabled={loading || saving}>
            Формат хийх
          </Button>
          <Button size="sm" variant="secondary" onClick={handleCopy} disabled={loading || saving}>
            Копилох
          </Button>
          <span className="ml-auto text-xs text-ink-subtle">{lineCount} мөр</span>
        </div>
      </Card>

      {parseError && (
        <Alert tone="danger">{parseError}</Alert>
      )}

      {saveResult && (
        <Alert tone={saveResult.failed > 0 ? "warning" : "success"}>
          {saveResult.saved} аялал хадгалагдлаа.
          {saveResult.failed > 0 && ` ${saveResult.failed} алдаатай:`}
          {saveResult.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {saveResult.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </Alert>
      )}

      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-surface/80">
            <Spinner className="h-8 w-8 text-brand" />
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={json}
          onChange={(e) => handleChange(e.target.value)}
          spellCheck={false}
          className={cx(
            "w-full rounded-xl border bg-[#1e1e2e] px-4 py-3 font-mono text-[13px] leading-relaxed text-[#cdd6f4] outline-none focus:ring-2 focus:ring-brand/40",
            parseError ? "border-danger" : "border-line-strong",
          )}
          style={{ minHeight: "60vh", resize: "vertical" }}
          placeholder='[{"route_name": "...", "adult_price": 1000000, ...}]'
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          loading={saving}
          disabled={loading || !json.trim()}
          onClick={() => void handleSave()}
        >
          <Icons.download size={14} />
          {tripCount() != null ? `Хадгалах (${tripCount()} аялал)` : "Хадгалах"}
        </Button>
        <p className="text-xs text-ink-subtle">
          ID бүхий аяллууд шинэчлэгдэнэ. ID-гүй бол шинэ аялал нэмэгдэнэ.
        </p>
      </div>

      <Card className="p-4">
        <p className="mb-2 text-sm font-semibold text-ink">ChatGPT-д өгөх заавар</p>
        <div className="rounded-lg bg-surface-sunken p-3 text-xs text-ink-muted leading-relaxed">
          <p className="font-medium text-ink mb-1">Дараах мессежийг ChatGPT-д илгээнэ үү:</p>
          <p className="italic text-ink-subtle">
            "Доорх JSON өгөгдлийг засаж өгнө үү. price_groups (огноо тус бүрийн үнэ), discounts (хямдрал), child_rules (хүүхдийн насны ангилал), aliases (өөр нэршил) талбаруудыг нэмнэ үү. Бусад талбарыг өөрчлөхгүй орхиж, JSON форматаар буцааж өгнө үү."
          </p>
          <p className="mt-2 text-ink-subtle">→ Копилсон JSON-ийг paste хийнэ → GPT хариулна → GPT-ийн хариултыг энд paste хийж Хадгалах дарна.</p>
        </div>
      </Card>
    </div>
  );
}
