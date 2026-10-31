import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Icons, Modal, Spinner, cx } from "@/components/ui";
import { TabHeader } from "./AdminShared";
import { GPT_PROMPT } from "@/lib/jsonEditorPrompt";
import { parseTripsJson, planJsonEditorSave, type JsonEditorPlan, type JsonEditorTrip } from "@/lib/jsonEditorPlan";

type Props = {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
};

type TripResult = { id: string; route_name: string; ok: boolean; created?: boolean; conflict?: boolean; error?: string };
type SaveOutcome = { saved: number; created: number; failed: number; results: TripResult[]; unchanged: number };

const STEPS: Array<{ title: string; text: string }> = [
  { title: "ChatGPT-д зааврыг хуулж илгээнэ", text: "Доорх товч ChatGPT-д илгээх заавар болон одоогийн аяллын өгөгдлийг нэг дор хуулна." },
  { title: "ChatGPT-ийн JSON хариултыг энд буулгана", text: "Засварлагч доторх бүх текстийг устгаад (Ctrl+A → Delete) хариултыг буулгана (Ctrl+V)." },
  { title: "«Хадгалах» дарж өөрчлөлтийг шалгана", text: "Зөвхөн өөрчлөгдсөн аялал, талбар жагсаагдана. Та шалгаад баталгаажуулсны дараа л хадгалагдана." },
];

export function JsonEditorTab({ apiFetch, onSaved }: Props) {
  const [json, setJson] = useState("");
  const [baseline, setBaseline] = useState<Map<string, JsonEditorTrip>>(new Map());
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [plan, setPlan] = useState<JsonEditorPlan | null>(null);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [copied, setCopied] = useState<"" | "prompt" | "json">("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  /** Loads the catalogue; keepText leaves the staff's pasted text in place after a partial save. */
  const loadTrips = useCallback(async (keepText = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/admin/trips-bulk");
      const data = await res.json().catch(() => ({})) as { trips?: JsonEditorTrip[]; versions?: Record<string, string>; error?: string };
      if (!res.ok || !Array.isArray(data.trips)) throw new Error(data.error || `HTTP ${res.status}`);
      setBaseline(new Map(data.trips.map((trip) => [String(trip.id), trip])));
      setVersions(data.versions || {});
      if (!keepText) {
        setJson(JSON.stringify(data.trips, null, 2));
        setParseError(null);
        setOutcome(null);
      }
    } catch (error) {
      setLoadError(`Аяллын өгөгдлийг ачаалж чадсангүй: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { void loadTrips(); }, [loadTrips]);

  const lineCount = useMemo(() => (json ? json.split("\n").length : 1), [json]);
  const gutterText = useMemo(() => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"), [lineCount]);
  const tripCount = useMemo(() => {
    const parsed = parseTripsJson(json);
    return "trips" in parsed ? parsed.trips.length : null;
  }, [json]);

  function reviewChanges() {
    setOutcome(null);
    const parsed = parseTripsJson(json);
    if ("error" in parsed) {
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    setPlan(planJsonEditorSave(parsed.trips, baseline));
  }

  async function applyPlan(current: JsonEditorPlan) {
    const payload = [...current.updates.map((update) => update.patch), ...current.creates.map((create) => create.trip)];
    if (payload.length === 0) {
      setPlan(null);
      return;
    }
    setSaving(true);
    try {
      const planVersions = Object.fromEntries(current.updates.map((update) => [update.id, versions[update.id]]));
      const res = await apiFetch("/api/admin/trips-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trips: payload, versions: planVersions }),
      });
      const data = await res.json().catch(() => ({})) as Partial<SaveOutcome> & { error?: string; message?: string };
      if (!res.ok || !Array.isArray(data.results)) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      const result: SaveOutcome = {
        saved: data.saved ?? 0, created: data.created ?? 0, failed: data.failed ?? 0,
        results: data.results, unchanged: current.unchanged,
      };
      setPlan(null);
      setOutcome(result);
      if (result.saved > 0) onSaved();
      // Saved trips have new versions now; a full success reloads the text too.
      await loadTrips(result.failed > 0);
    } catch (error) {
      setPlan(null);
      setParseError(`Хадгалж чадсангүй: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  function copy(kind: "prompt" | "json") {
    const text = kind === "prompt" ? `${GPT_PROMPT}\n\n${json}` : json;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      window.setTimeout(() => setCopied(""), 2500);
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

  const failures = outcome?.results.filter((result) => !result.ok) ?? [];
  const pending = plan ? plan.updates.length + plan.creates.length : 0;

  return (
    <div className="space-y-4">
      <TabHeader
        icon={<Icons.braces size={20} />}
        title="JSON засвар"
        description="Бүх аяллын өгөгдлийг нэг дор экспортлож, ChatGPT-ээр баяжуулаад буцааж хадгална."
      />

      <Card className="p-4">
        <p className="mb-3 text-sm font-semibold text-ink">ChatGPT ашиглан өгөгдөл нэмэх</p>
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">{index + 1}</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{step.title}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{step.text}</p>
                {index === 0 && (
                  <Button size="sm" variant={copied === "prompt" ? "success" : "primary"} className="mt-2"
                    disabled={loading || !json.trim()} onClick={() => copy("prompt")}>
                    {copied === "prompt" ? "Хуулагдлаа — ChatGPT-д буулгана уу" : "Заавар + өгөгдөл хуулах"}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {parseError && <Alert tone="danger">{parseError}</Alert>}
      {outcome && (
        <Alert tone={outcome.failed > 0 ? "warning" : "success"}>
          {outcome.saved > 0
            ? `${outcome.saved} аялал хадгалагдлаа${outcome.created ? ` (${outcome.created} шинэ, ноорог төлөвтэй)` : ""}.`
            : "Ямар ч аялал хадгалагдсангүй."}
          {outcome.unchanged > 0 && ` ${outcome.unchanged} аялал өөрчлөгдөөгүй тул илгээгээгүй.`}
          {failures.length > 0 && (
            <>
              {` ${failures.length} аялал хадгалагдсангүй:`}
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                {failures.map((failure, index) => (
                  <li key={`${failure.id}-${index}`}><span className="font-semibold">{failure.route_name || failure.id || "—"}</span>: {failure.error}</li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">
          {loading ? "Ачаалж байна…" : tripCount != null ? `${tripCount} аялал` : "JSON буруу байна"}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void loadTrips()} disabled={loading || saving}>
          <Icons.refresh size={13} /> Дахин татах
        </Button>
        <Button size="sm" variant="secondary" onClick={() => copy("json")} disabled={loading || !json.trim()}>
          {copied === "json" ? "Хуулагдлаа" : "JSON хуулах"}
        </Button>
        <Button size="sm" variant="secondary" onClick={downloadJson} disabled={loading || !json.trim()}>
          <Icons.download size={13} /> Файл татах
        </Button>
        <span className="ml-auto text-xs tabular-nums text-ink-muted">{lineCount.toLocaleString("mn-MN")} мөр</span>
      </div>

      {/* Fixed-height editor: the textarea scrolls and the gutter follows it, so a
          12,000-line catalogue no longer stretches the page to 250,000 px. */}
      <div className={cx("relative flex h-[65vh] min-h-[22rem] overflow-hidden rounded-xl border bg-[#1e1e2e]", parseError ? "border-danger" : "border-line-strong")}>
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
            <Spinner className="h-8 w-8 text-white" />
          </div>
        )}
        <pre ref={gutterRef} aria-hidden
          className="m-0 shrink-0 select-none overflow-hidden border-r border-white/10 bg-[#181825] px-3 py-3 text-right font-mono text-[13px] leading-relaxed text-[#7f849c]">
          {gutterText}
        </pre>
        <textarea
          ref={textareaRef}
          value={json}
          aria-label="Аяллын JSON"
          onChange={(e) => { setJson(e.target.value); setParseError(null); setOutcome(null); }}
          onScroll={() => {
            if (gutterRef.current && textareaRef.current) gutterRef.current.scrollTop = textareaRef.current.scrollTop;
          }}
          spellCheck={false}
          wrap="off"
          className="h-full min-w-0 flex-1 resize-none overflow-auto bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-[#cdd6f4] outline-none"
          placeholder="ChatGPT-ийн JSON-ийг энд буулгана уу..."
        />
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm">
        <Button loading={saving} disabled={loading || saving || !json.trim()} onClick={reviewChanges} className="px-6">
          <Icons.check size={14} /> Өөрчлөлтийг шалгаад хадгалах
        </Button>
        <p className="text-xs text-ink-muted">
          Зөвхөн өөрчлөгдсөн аялал хадгалагдана. Таныг ачаалснаас хойш өөр газраас засагдсан аяллыг дарж бичихгүй.
        </p>
      </div>

      <Modal
        open={plan != null}
        onClose={() => { if (!saving) setPlan(null); }}
        title={pending > 0 ? `${pending} аялалд өөрчлөлт орно` : "Хадгалах өөрчлөлт алга"}
        description={plan && plan.unchanged > 0 ? `${plan.unchanged} аялал өөрчлөгдөөгүй тул илгээхгүй.` : undefined}
        panelClassName="max-w-2xl"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setPlan(null)} disabled={saving}>Болих</Button>
            {pending > 0 && (
              <Button loading={saving} onClick={() => plan && void applyPlan(plan)}>
                {`${pending} аялал хадгалах`}
              </Button>
            )}
          </div>
        }
      >
        {plan && (
          <div className="space-y-4 text-sm">
            {plan.updates.length > 0 && (
              <section>
                <p className="mb-1.5 font-semibold text-ink">Шинэчлэгдэх ({plan.updates.length})</p>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {plan.updates.map((update) => (
                    <li key={update.id} className="px-3 py-2">
                      <p className="font-medium text-ink">{update.name}</p>
                      <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                        {update.changes.map((change) => (
                          <li key={change.field}>
                            <span className="font-medium text-ink">{change.label}</span>
                            {change.before !== undefined && <span className="tabular-nums">: {change.before} → {change.after}</span>}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {plan.creates.length > 0 && (
              <section>
                <p className="mb-1.5 font-semibold text-ink">Шинээр нэмэгдэх ({plan.creates.length})</p>
                <p className="mb-1.5 text-xs text-ink-muted">Төлөв заагаагүй бол ноорог болж нэмэгдэнэ — сайт, ботод шууд харагдахгүй.</p>
                <ul className="list-disc space-y-0.5 pl-5 text-ink">
                  {plan.creates.map((create, index) => <li key={`${create.name}-${index}`}>{create.name}</li>)}
                </ul>
              </section>
            )}
            {plan.blocked.length > 0 && (
              <section>
                <p className="mb-1.5 font-semibold text-danger">Хадгалахгүй ({plan.blocked.length})</p>
                <ul className="space-y-1 text-xs text-ink-muted">
                  {plan.blocked.map((entry, index) => <li key={index}><span className="font-medium text-ink">{entry.name}</span>: {entry.reason}</li>)}
                </ul>
              </section>
            )}
            {plan.ignoredFields.length > 0 && (
              <p className="text-xs text-ink-muted">Хадгалагдахгүй талбар: {plan.ignoredFields.join(", ")}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
