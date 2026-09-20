import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, Input, useToast } from "@/components/ui";
import { LoadingPanel, SectionHeading, StatCard, TabHeader } from "./AdminShared";
import { formatTime } from "@/lib/adminUtils";

type LogLevel = "error" | "warn" | "info";

type ErrorLogRow = {
  id: number;
  created_at: string;
  level: LogLevel;
  event: string;
  message: string;
  request_id: string;
  correlation_id: string;
  sender_hash: string;
  fields: Record<string, unknown>;
};

type ErrorLogSummary = { event: string; level: LogLevel; count: number; last_at: string };

const RANGES = [
  { hours: 24, label: "24 цаг" },
  { hours: 72, label: "3 хоног" },
  { hours: 168, label: "7 хоног" },
] as const;

const LEVEL_TONE: Record<LogLevel, "danger" | "warning" | "neutral"> = {
  error: "danger",
  warn: "warning",
  info: "neutral",
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  error: "Алдаа",
  warn: "Анхааруулга",
  info: "Мэдээлэл",
};

export function ErrorLogsTab({
  apiFetch,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const toast = useToast();
  const [hours, setHours] = useState<number>(24);
  const [level, setLevel] = useState<"" | LogLevel>("");
  const [event, setEvent] = useState("");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [retentionDays, setRetentionDays] = useState(7);
  const [summary, setSummary] = useState<ErrorLogSummary[]>([]);
  const [rows, setRows] = useState<ErrorLogRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ hours: String(hours), limit: "200" });
      if (level) params.set("level", level);
      if (event) params.set("event", event);
      if (search) params.set("search", search);
      const res = await apiFetch(`/api/admin/error-logs?${params.toString()}`);
      const data = await res.json();
      setConfigured(data?.configured !== false);
      setRetentionDays(typeof data?.retentionDays === "number" ? data.retentionDays : 7);
      setSummary(Array.isArray(data?.summary) ? data.summary : []);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      toast.error("Алдааны бүртгэл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, toast, hours, level, event, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const errorCount = summary.filter((s) => s.level === "error").reduce((n, s) => n + s.count, 0);
  const warnCount = summary.filter((s) => s.level === "warn").reduce((n, s) => n + s.count, 0);

  return (
    <div className="space-y-6">
      <TabHeader
        icon={<Icons.alert size={20} />}
        title="Алдааны бүртгэл"
        description={`Ботын бүх алдаа, анхааруулга ${retentionDays} хоног хадгалагдаад автоматаар устна. AI муудсан гэж хэлэхэд эндээс шалтгааныг нь хараарай.`}
        actions={
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
            <Icons.refresh size={14} />
            Шинэчлэх
          </Button>
        }
      />

      {!configured && (
        <Alert tone="info">
          Өгөгдлийн сан холбогдоогүй тул алдааг хадгалах боломжгүй байна.
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((range) => (
          <Button
            key={range.hours}
            size="sm"
            variant={hours === range.hours ? "primary" : "secondary"}
            onClick={() => setHours(range.hours)}
          >
            {range.label}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        {(["", "error", "warn", "info"] as const).map((value) => (
          <Button
            key={value || "all"}
            size="sm"
            variant={level === value ? "primary" : "secondary"}
            onClick={() => setLevel(value)}
          >
            {value ? LEVEL_LABEL[value] : "Бүгд"}
          </Button>
        ))}
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(searchDraft.trim());
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            placeholder="Хайх: event, алдааны текст, request id…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
          />
        </div>
        <Button type="submit" size="md" variant="secondary">
          <Icons.search size={14} />
          Хайх
        </Button>
        {(event || search) && (
          <Button
            type="button"
            size="md"
            variant="ghost"
            onClick={() => {
              setEvent("");
              setSearch("");
              setSearchDraft("");
            }}
          >
            Цэвэрлэх
          </Button>
        )}
      </form>

      {loading ? (
        <LoadingPanel />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Алдаа" value={errorCount} tone={errorCount ? "text-danger" : undefined} />
            <StatCard label="Анхааруулга" value={warnCount} tone={warnCount ? "text-warning" : undefined} />
            <StatCard label="Өөр төрөл" value={summary.length} />
          </div>

          <Card className="p-4">
            <SectionHeading
              title="Төрлөөр нь"
              description="Аль алдаа хамгийн олон давтагдаж байгааг эндээс хараад дарж шүүнэ."
            />
            {summary.length === 0 ? (
              <EmptyState
                icon={<Icons.check size={24} />}
                title="Алдаа алга"
                description="Сонгосон хугацаанд бүртгэгдсэн алдаа байхгүй байна."
              />
            ) : (
              <div className="mt-3 space-y-1.5">
                {summary.map((item) => (
                  <button
                    key={`${item.event}:${item.level}`}
                    type="button"
                    onClick={() => setEvent(item.event === event ? "" : item.event)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      item.event === event
                        ? "border-brand-border bg-brand-soft/50"
                        : "border-line bg-surface-sunken hover:border-brand-border"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge tone={LEVEL_TONE[item.level]}>{LEVEL_LABEL[item.level]}</Badge>
                      <span className="truncate font-mono text-xs text-ink">{item.event}</span>
                    </span>
                    <span className="shrink-0 text-xs text-ink-muted">
                      <span className="font-semibold tabular-nums text-ink">{item.count}</span>
                      {" · "}
                      {formatTime(item.last_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {rows.length > 0 && (
            <Card className="p-4">
              <SectionHeading
                title="Сүүлийн бүртгэлүүд"
                description={`Хамгийн сүүлийн ${rows.length} бичлэг. Дэлгэрэнгүйг харахын тулд дарна уу.`}
              />
              <div className="mt-3 space-y-2">
                {rows.map((row) => (
                  <details
                    key={row.id}
                    className="rounded-lg border border-line bg-surface-sunken p-3 text-sm"
                  >
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={LEVEL_TONE[row.level]}>{LEVEL_LABEL[row.level]}</Badge>
                          <span className="truncate font-mono text-xs text-ink">{row.event}</span>
                        </span>
                        {row.message && (
                          <span className="mt-1 block truncate text-xs text-ink-muted">
                            {row.message}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-ink-subtle">
                        {formatTime(row.created_at)}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-xs text-ink-muted">
                      {row.message && <p className="whitespace-pre-wrap break-words">{row.message}</p>}
                      {row.request_id && (
                        <p>
                          request: <span className="font-mono">{row.request_id}</span>
                        </p>
                      )}
                      {row.sender_hash && (
                        <p>
                          хэрэглэгч: <span className="font-mono">{row.sender_hash}</span>
                        </p>
                      )}
                      <pre className="max-h-64 overflow-auto rounded bg-surface p-2 text-[11px] leading-relaxed text-ink">
                        {JSON.stringify(row.fields, null, 2)}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
