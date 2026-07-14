import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Icons, Spinner, cx } from "@/components/ui";
import { TabHeader } from "./AdminShared";
import { GPT_PROMPT } from "@/lib/jsonEditorPrompt";

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
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumRef = useRef<HTMLDivElement>(null);

  const loadTrips = useCallback(async () => {
    setLoading(true);
    setSaveResult(null);
    setParseError(null);
    try {
      const res = await apiFetch("/api/admin/trips-bulk");
      const data = await res.json() as { trips: unknown[] };
      setJson(JSON.stringify(data.trips, null, 2));
    } catch {
      setJson("");
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
    const trips = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).trips))
        ? (parsed as Record<string, unknown>).trips as unknown[]
        : null;
    if (!trips) {
      setParseError("JSON нь [ ] array хэлбэртэй байх ёстой.");
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

  function copyJson() {
    void navigator.clipboard.writeText(json).then(() => {
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    });
  }

  function downloadJson() {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uudam-trips-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyPrompt() {
    void navigator.clipboard.writeText(GPT_PROMPT + "\n\n" + json).then(() => {
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2500);
    });
  }

  function tripCount() {
    try {
      const p = JSON.parse(json) as unknown;
      if (Array.isArray(p)) return p.length;
      if (p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).trips))
        return ((p as Record<string, unknown>).trips as unknown[]).length;
    } catch { /* ignore */ }
    return null;
  }

  const count = tripCount();

  return (
    <div className="space-y-4">
      <TabHeader
        icon={<Icons.braces size={20} />}
        title="JSON засвар"
        description="Бүх аяллын өгөгдлийг нэг дор экспортлож, ChatGPT-ээр баяжуулаад буцааж хадгална."
      />
      {/* How-to steps */}
      <Card className="p-4">
        <p className="mb-3 text-sm font-semibold text-ink">ChatGPT ашиглан өгөгдөл нэмэх — алхам алхмаар</p>
        <ol className="space-y-3">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">1</span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">ChatGPT-д зааврыг хуулж илгээнэ</p>
              <p className="text-xs text-ink-subtle mt-0.5">Дараах товч нь ChatGPT-д илгээх бүрэн зааврыг + манай өгөгдлийг нэг дор хуулна.</p>
              <Button
                size="sm"
                variant={copiedPrompt ? "success" : "primary"}
                className="mt-2"
                disabled={loading || !json.trim()}
                onClick={copyPrompt}
              >
                {copiedPrompt ? "✓ Хуулагдлаа! ChatGPT-д paste хийнэ үү" : "ChatGPT-д илгээх зааврыг хуулах"}
              </Button>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">2</span>
            <div>
              <p className="text-sm font-medium text-ink">ChatGPT хариултаа өгнө</p>
              <p className="text-xs text-ink-subtle mt-0.5">ChatGPT price_groups, discounts, aliases, child_rules талбаруудыг нэмсэн JSON буцааж өгнө. Хариулт бүхлээрээ JSON байх ёстой.</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">3</span>
            <div>
              <p className="text-sm font-medium text-ink">ChatGPT-ийн JSON-ийг доорх хэсэгт paste хийнэ</p>
              <p className="text-xs text-ink-subtle mt-0.5">Доорх харанхуй хэсэгт бүх текстийг устгаж (Ctrl+A → Delete), ChatGPT-ийн хариултыг paste хийнэ (Ctrl+V).</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">4</span>
            <div>
              <p className="text-sm font-medium text-ink">&quot;Мэдээлэл хадгалах&quot; товч дарна</p>
              <p className="text-xs text-ink-subtle mt-0.5">Бүх аяллын өгөгдөл нэг дор шинэчлэгдэнэ. Бот тэр даруй зөв хариулж эхэлнэ.</p>
            </div>
          </li>
        </ol>
      </Card>

      {parseError && <Alert tone="danger">{parseError}</Alert>}

      {saveResult && (
        <Alert tone={saveResult.failed > 0 ? "warning" : "success"}>
          ✓ {saveResult.saved} аялал амжилттай хадгалагдлаа!
          {saveResult.failed > 0 && (
            <>
              {" "}{saveResult.failed} алдаатай:
              <ul className="mt-1 list-disc pl-4 text-xs">
                {saveResult.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </>
          )}
        </Alert>
      )}

      {/* Editor toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">
          {loading ? "Татаж байна…" : count != null ? `${count} аялал` : "Өгөгдөл"}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void loadTrips()} disabled={loading || saving}>
          <Icons.refresh size={13} />
          Дахин татах
        </Button>
        <Button size="sm" variant="secondary" onClick={copyJson} disabled={loading || !json.trim()}>
          {copiedJson ? "✓ Хуулагдлаа" : "JSON хуулах"}
        </Button>
        <Button size="sm" variant="secondary" onClick={downloadJson} disabled={loading || !json.trim()}>
          <Icons.download size={13} />
          Файл татах
        </Button>
        <span className="ml-auto text-xs text-ink-subtle">{json.split("\n").length} мөр</span>
      </div>

      {/* Dark JSON editor with line numbers */}
      <div
        className={cx(
          "relative flex overflow-hidden rounded-xl border bg-[#1e1e2e]",
          parseError ? "border-danger" : "border-line-strong",
        )}
        style={{ minHeight: "65vh" }}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
            <Spinner className="h-8 w-8 text-white" />
          </div>
        )}
        {/* Line numbers */}
        <div
          ref={lineNumRef}
          aria-hidden
          className="select-none overflow-hidden border-r border-white/10 bg-[#181825] px-3 py-3 text-right font-mono text-[13px] leading-relaxed text-[#585b70]"
          style={{ minWidth: "3.2rem" }}
        >
          {json.split("\n").map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        {/* Editor */}
        <textarea
          ref={textareaRef}
          value={json}
          onChange={(e) => handleChange(e.target.value)}
          onScroll={() => {
            if (lineNumRef.current && textareaRef.current) {
              lineNumRef.current.scrollTop = textareaRef.current.scrollTop;
            }
          }}
          spellCheck={false}
          className="flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-[#cdd6f4] outline-none"
          style={{ minHeight: "65vh" }}
          placeholder="ChatGPT-ийн JSON-ийг энд paste хийнэ үү..."
        />
      </div>

      {/* Save button — prominent */}
      <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm">
        <Button
          loading={saving}
          disabled={loading || !json.trim()}
          onClick={() => void handleSave()}
          className="px-6"
        >
          <Icons.download size={14} />
          {count != null ? `Мэдээлэл хадгалах (${count} аялал)` : "Мэдээлэл хадгалах"}
        </Button>
        <p className="text-xs text-ink-subtle">
          ID бүхий аяллууд шинэчлэгдэнэ · ID-гүй бол шинэ аялал нэмэгдэнэ
        </p>
      </div>
    </div>
  );
}
