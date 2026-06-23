import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "@/components/ui";
import type {
  AIAction,
  AIProposal,
  AttachedFile,
  ChatButton,
  ChatMessage,
  ClarificationAnswer,
  ClarificationQuestion,
  ConflictItem,
  ControlState,
  DriveSyncDiagnostics,
  DriveSyncRecentFile,
  FlowRule,
  LeadStats,
  PageControlState,
  PauseRow,
  ProposalMsg,
  ReadinessReport,
  RecentRow,
  SettingsForm,
  StructuredRow,
  TravelBotSettings,
  TravelLead,
  TravelTrip,
} from "@/lib/adminTypes";
import {
  FIELD_LABELS,
  STATUS_LABELS,
  buildProposalClarifications,
  compactWarnings,
  describeAction,
  summarizeConflict,
} from "@/lib/adminProposalUtils";
import { SectionHeading, StructuredEditor } from "./AdminShared";
import { readGreetingDraft, type GreetingDraft } from "./adminTabData";
import {
  DURATIONS,
  HANDOFF_DURATION_CUSTOM,
  HANDOFF_DURATION_OPTIONS,
  MAX_AI_INPUT_CHARS,
  QUICK_ACTIONS,
  STATUS_TONE,
  asInt,
  conflictTone,
  driveSyncTone,
  formatBytes,
  formatMoney,
  formatTime,
  handoffDurationSelectValue,
  settingsToForm,
  shortId,
  splitLines,
  timeLeft,
  toStructuredRows,
} from "@/lib/adminUtils";

export function GreetingTab({
  extra,
  apiFetch,
  onSaved,
  autoPhotos,
}: {
  extra: Record<string, unknown>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
  autoPhotos: string[];
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<GreetingDraft>(() => readGreetingDraft(extra));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [defaultUploading, setDefaultUploading] = useState<string[]>([]);
  const [defaultDragging, setDefaultDragging] = useState(false);
  const defaultFileInputRef = useRef<HTMLInputElement>(null);

  const extraRef = useRef(extra);
  useEffect(() => {
    if (extraRef.current !== extra) {
      extraRef.current = extra;
      setDraft(readGreetingDraft(extra));
    }
  }, [extra]);

  async function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.size <= 10 * 1024 * 1024);
    if (!arr.length) return;
    setUploading((p) => [...p, ...arr.map((f) => f.name)]);
    for (const file of arr) {
      try {
        const sigRes = await apiFetch("/api/admin/upload-image", { method: "POST" });
        if (!sigRes.ok) throw new Error("upload not configured");
        const sig = (await sigRes.json()) as {
          signature: string;
          timestamp: number;
          cloudName: string;
          apiKey: string;
          folder: string;
        };
        const fd = new FormData();
        fd.append("file", file);
        fd.append("api_key", sig.apiKey);
        fd.append("timestamp", String(sig.timestamp));
        fd.append("signature", sig.signature);
        fd.append("folder", sig.folder);
        const up = await fetch(
          `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
          { method: "POST", body: fd },
        );
        const upJson = (await up.json()) as { secure_url?: string };
        if (!up.ok || !upJson.secure_url) throw new Error("cloudinary failed");
        setDraft((d) => ({ ...d, photoUrls: [...d.photoUrls, upJson.secure_url!] }));
      } catch {
        toast.error(`"${file.name}" зураг оруулж чадсангүй.`);
      } finally {
        setUploading((p) => p.filter((n) => n !== file.name));
      }
    }
  }

  async function uploadDefaultFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.size <= 10 * 1024 * 1024);
    if (!arr.length) return;
    setDefaultUploading((p) => [...p, ...arr.map((f) => f.name)]);
    for (const file of arr) {
      try {
        const sigRes = await apiFetch("/api/admin/upload-image", { method: "POST" });
        if (!sigRes.ok) throw new Error("upload not configured");
        const sig = (await sigRes.json()) as {
          signature: string;
          timestamp: number;
          cloudName: string;
          apiKey: string;
          folder: string;
        };
        const fd = new FormData();
        fd.append("file", file);
        fd.append("api_key", sig.apiKey);
        fd.append("timestamp", String(sig.timestamp));
        fd.append("signature", sig.signature);
        fd.append("folder", sig.folder);
        const up = await fetch(
          `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
          { method: "POST", body: fd },
        );
        const upJson = (await up.json()) as { secure_url?: string };
        if (!up.ok || !upJson.secure_url) throw new Error("cloudinary failed");
        setDraft((d) => ({
          ...d,
          defaultPhotoUrls: [...d.defaultPhotoUrls, upJson.secure_url!],
        }));
      } catch {
        toast.error(`"${file.name}" зураг оруулж чадсангүй.`);
      } finally {
        setDefaultUploading((p) => p.filter((n) => n !== file.name));
      }
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extra: { ...extra, greeting: draft } }),
      });
      if (!res.ok) {
        toast.error("Мэндчилгээ хадгалж чадсангүй.");
        return;
      }
      onSaved();
      toast.success("Мэндчилгээ хадгалагдлаа.");
    } catch {
      toast.error("Мэндчилгээ хадгалж чадсангүй.");
    } finally {
      setSaving(false);
    }
  }

  const previewText =
    draft.text.trim() ||
    "Уудам Трэвел-д тавтай морилно уу! 🌏 Бид танд хамгийн шилдэг аяллуудыг санал болгож байна.";
  // The default album always sends first, so it takes priority in the preview.
  // After it, in manual mode show the picked photos; in auto mode show the
  // actual photos that would be auto-sampled from active trips.
  const previewPhotos = [
    ...draft.defaultPhotoUrls,
    ...(draft.usePhotoUrls ? draft.photoUrls : autoPhotos),
  ].slice(0, 4);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Hero header */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <Icons.chevronRight size={20} />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-ink">Мэндчилгээ</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Хэрэглэгч анх бичихэд бот автоматаар илгээх текст ба зургийг та өөрөө удирдана.
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* ---- Left: editor ---- */}
        <div className="space-y-4">
          {/* Master toggle */}
          <Card className="flex items-center justify-between gap-4 p-4">
            <div className="flex items-start gap-3">
              <div
                className={cx(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors",
                  draft.enabled
                    ? "bg-success-soft text-success"
                    : "bg-surface-sunken text-ink-subtle",
                )}
              >
                <Icons.check size={18} />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Мэндчилгээ идэвхтэй</p>
                <p className="text-xs text-ink-subtle">
                  Унтраавал бот мэндчилгээ илгээхгүй, шууд асуултад хариулна.
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
              className={cx(
                "relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none",
                draft.enabled ? "bg-brand" : "bg-line-strong",
              )}
              aria-label="Мэндчилгээ асаах/унтраах"
            >
              <span
                className={cx(
                  "inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
                  draft.enabled ? "translate-x-7" : "translate-x-0",
                )}
              />
            </button>
          </Card>

          <div
            className={cx(
              "space-y-4 transition-opacity",
              draft.enabled ? "" : "pointer-events-none opacity-50",
            )}
          >
            {/* Text */}
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <Icons.edit size={15} className="text-ink-muted" />
                <p className="text-sm font-semibold text-ink">Мэндчилгээний текст</p>
              </div>
              <Textarea
                rows={4}
                placeholder="Жишээ: Уудам Трэвел-д тавтай морилно уу! 🌏 Бид танд хамгийн шилдэг аяллуудыг санал болгож байна. Доорх зургуудаас сонирхсон аялалаа сонгоорой."
                value={draft.text}
                onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              />
              <p className="mt-1.5 text-xs text-ink-subtle">
                Хоосон орхивол ботын ерөнхий мэндчилгээ илгээгдэнэ.
              </p>
            </Card>

            {/* Default album — always sent first */}
            <Card className="p-4">
              <div className="mb-1 flex items-center gap-2">
                <Icons.trips size={15} className="text-ink-muted" />
                <p className="text-sm font-semibold text-ink">Үндсэн зураг (default album)</p>
              </div>
              <p className="mb-3 text-xs text-ink-subtle">
                Мэндчилгээнд хамгийн түрүүнд илгээгдэх тогтмол зургууд. Энд тавьсан
                зургууд үргэлж эхэнд явна.
              </p>

              {/* Drag-drop upload */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDefaultDragging(true);
                }}
                onDragLeave={() => setDefaultDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDefaultDragging(false);
                  void uploadDefaultFiles(e.dataTransfer.files);
                }}
                onClick={() => defaultFileInputRef.current?.click()}
                className={cx(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 transition-colors",
                  defaultDragging
                    ? "border-brand bg-brand-soft"
                    : "border-line-strong bg-surface-sunken hover:border-brand",
                )}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-brand">
                  <Icons.plus size={20} />
                </div>
                <p className="text-sm font-medium text-ink">
                  Зураг чирж оруулах эсвэл дарж сонгох
                </p>
                <p className="text-xs text-ink-subtle">
                  PNG, JPG, WEBP — хамгийн ихдээ 10MB
                </p>
                <input
                  ref={defaultFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void uploadDefaultFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>

              {defaultUploading.length > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                  <Spinner className="h-3.5 w-3.5" />
                  Оруулж байна: {defaultUploading.join(", ")}…
                </div>
              )}

              {draft.defaultPhotoUrls.length > 0 && (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {draft.defaultPhotoUrls.map((url, idx) => (
                      <div
                        key={idx}
                        className="group relative aspect-square overflow-hidden rounded-xl border border-line"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              defaultPhotoUrls: d.defaultPhotoUrls.filter(
                                (_, i) => i !== idx,
                              ),
                            }))
                          }
                          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
                          aria-label="Устгах"
                        >
                          <Icons.trash size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-ink-subtle">
                    {draft.defaultPhotoUrls.length}/10 зураг · хамгийн ихдээ 10 илгээгдэнэ.
                  </p>
                </>
              )}
            </Card>

            {/* Photos */}
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Icons.trips size={15} className="text-ink-muted" />
                <p className="text-sm font-semibold text-ink">Мэндчилгээний зураг</p>
              </div>

              {/* Source choice as selectable cards */}
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  {
                    value: false,
                    title: "Автоматаар",
                    desc: "Аялал бүрээс нэг зураг сонгоно",
                  },
                  {
                    value: true,
                    title: "Гараар сонгох",
                    desc: "Өөрийн зургуудыг байршуулна",
                  },
                ].map((opt) => {
                  const active = draft.usePhotoUrls === opt.value;
                  return (
                    <button
                      key={String(opt.value)}
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({ ...d, usePhotoUrls: opt.value }))
                      }
                      className={cx(
                        "rounded-xl border p-3 text-left transition-colors",
                        active
                          ? "border-brand bg-brand-soft"
                          : "border-line-strong bg-surface hover:border-brand/50",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cx(
                            "flex h-4 w-4 items-center justify-center rounded-full border-2",
                            active ? "border-brand" : "border-line-strong",
                          )}
                        >
                          {active && <span className="h-2 w-2 rounded-full bg-brand" />}
                        </span>
                        <span className="text-sm font-medium text-ink">{opt.title}</span>
                      </div>
                      <p className="mt-1 pl-6 text-xs text-ink-subtle">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>

              {draft.usePhotoUrls && (
                <div className="mt-3">
                  {/* Drag-drop upload */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      void uploadFiles(e.dataTransfer.files);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={cx(
                      "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 transition-colors",
                      dragging
                        ? "border-brand bg-brand-soft"
                        : "border-line-strong bg-surface-sunken hover:border-brand",
                    )}
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-brand">
                      <Icons.plus size={20} />
                    </div>
                    <p className="text-sm font-medium text-ink">
                      Зураг чирж оруулах эсвэл дарж сонгох
                    </p>
                    <p className="text-xs text-ink-subtle">
                      PNG, JPG, WEBP — хамгийн ихдээ 10MB
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) void uploadFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </div>

                  {uploading.length > 0 && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                      <Spinner className="h-3.5 w-3.5" />
                      Оруулж байна: {uploading.join(", ")}…
                    </div>
                  )}

                  {draft.photoUrls.length > 0 && (
                    <>
                      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {draft.photoUrls.map((url, idx) => (
                          <div
                            key={idx}
                            className="group relative aspect-square overflow-hidden rounded-xl border border-line"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="" className="h-full w-full object-cover" />
                            <button
                              type="button"
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  photoUrls: d.photoUrls.filter((_, i) => i !== idx),
                                }))
                              }
                              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
                              aria-label="Устгах"
                            >
                              <Icons.trash size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-ink-subtle">
                        {draft.photoUrls.length}/10 зураг · хамгийн ихдээ 10 илгээгдэнэ.
                      </p>
                    </>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* ---- Right: live preview ---- */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-subtle">
            Урьдчилан харах
          </p>
          <div className="rounded-2xl border border-line bg-surface-sunken p-3">
            {/* chat header */}
            <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
                У
              </div>
              <div>
                <p className="text-xs font-semibold text-ink">Уудам Трэвел</p>
                <p className="text-[10px] text-ink-subtle">Messenger</p>
              </div>
            </div>

            {!draft.enabled ? (
              <p className="py-6 text-center text-xs text-ink-subtle">
                Мэндчилгээ унтраалттай. Бот шууд хариулна.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-surface px-3 py-2 text-xs text-ink shadow-sm">
                  {previewText}
                </div>
                {previewPhotos.length > 0 ? (
                  <>
                    <div className="grid grid-cols-2 gap-1.5">
                      {previewPhotos.map((url, i) => (
                        <div
                          key={i}
                          className="aspect-square overflow-hidden rounded-xl border border-line"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="" className="h-full w-full object-cover" />
                        </div>
                      ))}
                    </div>
                    {!draft.usePhotoUrls && (
                      <p className="text-[11px] text-ink-subtle">
                        ↑ Аяллаас автоматаар сонгогдсон зургууд (аялал бүрээс нэг).
                      </p>
                    )}
                  </>
                ) : draft.usePhotoUrls ? (
                  <p className="text-[11px] text-ink-subtle">Зураг сонгоогүй байна.</p>
                ) : (
                  <p className="text-[11px] text-ink-subtle">
                    Идэвхтэй аялалд зураг алга. Аялал нэмж зураг оруулна уу.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save bar */}
      <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Хадгалж байна…" : "Хадгалах"}
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Payments Tab (QPay) — OFF by default
   ---------------------------------------------------------------- */
type PaymentRow = {
  id: number;
  invoice_id: string;
  platform: string;
  sender_id: string;
  customer_name: string;
  trip_name: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "expired" | "cancelled";
  note: string;
  created_at: string;
  paid_at: string | null;
};

type PaymentStats = { total: number; paid: number; pending: number; paidAmount: number };

const PAYMENT_STATUS_MN: Record<PaymentRow["status"], string> = {
  pending: "Хүлээгдэж буй",
  paid: "Төлсөн",
  expired: "Хугацаа дууссан",
  cancelled: "Цуцалсан",
};

const PAYMENT_STATUS_TONE: Record<
  PaymentRow["status"],
  "neutral" | "warning" | "success" | "danger"
> = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  cancelled: "danger",
};
