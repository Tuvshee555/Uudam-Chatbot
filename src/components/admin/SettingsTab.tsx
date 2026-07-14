import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Icons, Input, Select, Switch, Textarea, cx } from "@/components/ui";
import type { DriveSyncDiagnostics, SettingsForm } from "@/lib/adminTypes";
import { SectionHeading, StructuredEditor, TabHeader } from "./AdminShared";
import { HANDOFF_DURATION_CUSTOM, HANDOFF_DURATION_OPTIONS, driveSyncTone, formatTime, getTestBotConversationId, handoffDurationSelectValue } from "@/lib/adminUtils";

export function SettingsTab({
  form,
  setForm,
  updatedAt,
  busy,
  driveSync,
  syncBusy,
  onSyncDriveNow,
  onSave,
  onRequestClear,
}: {
  form: SettingsForm;
  setForm: React.Dispatch<React.SetStateAction<SettingsForm | null>>;
  updatedAt?: string;
  busy: boolean;
  driveSync: DriveSyncDiagnostics | null;
  syncBusy: boolean;
  onSyncDriveNow: () => void;
  onSave: () => void;
  onRequestClear: () => void;
}) {
  function patch(partial: Partial<SettingsForm>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  const handoffDurationMode = handoffDurationSelectValue(form.handoff_pause_minutes);
  const [showOptionalData, setShowOptionalData] = useState(false);

  return (
    <div className="space-y-3">
      <TabHeader
        icon={<Icons.settings size={20} />}
        title="Тохиргоо"
        description="Ботын үндсэн дүрэм, автомат хариу, товчлуур болон хүнд шилжүүлэх тохиргоо."
      />
      {driveSync?.configured && (
      <Card className="p-4">
        <SectionHeading
          title="Файлын автомат шинэчлэл"
          description="Холбосон хавтасны шинэ болон өөрчлөгдсөн файлуудыг автоматаар уншина."
          action={
            <Button size="sm" loading={syncBusy} onClick={onSyncDriveNow}>
              <Icons.refresh size={15} />
              Одоо шинэчлэх
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={driveSync?.enabled ? "success" : "neutral"} dot>
              {driveSync?.enabled ? "Автомат" : "Гараар"}
            </Badge>
            <Badge tone={driveSyncTone(driveSync?.state.status)}>
              {driveSync?.state.status === "running"
                ? "Уншиж байна"
                : driveSync?.state.status === "success"
                  ? "Амжилттай"
                  : driveSync?.state.status === "warning"
                    ? "Шалгах зүйлтэй"
                    : driveSync?.state.status === "error"
                      ? "Алдаа гарсан"
                      : "Бэлэн"}
            </Badge>
            <span className="text-xs text-ink-subtle">
              Давтамж: {driveSync?.interval_minutes ?? 30} мин
            </span>
          </div>

            <div className="rounded-lg border border-line bg-surface-sunken p-3 text-sm text-ink-muted">
              <p>Сүүлд шалгасан: {formatTime(driveSync.state.last_checked_at)}</p>
              <p>Сүүлд дууссан: {formatTime(driveSync.state.last_synced_at)}</p>
              <p>
                Үзсэн {driveSync.state.files_examined} · Өөрчлөгдсөн{" "}
                {driveSync.state.files_changed} · Автоматаар хадгалсан{" "}
                {driveSync.state.files_applied} · Хяналт шаардлагатай{" "}
                {driveSync.state.files_blocked}
              </p>
              {driveSync.state.last_summary && (
                <p className="mt-2 whitespace-pre-wrap text-ink">
                  {driveSync.state.last_summary}
                </p>
              )}
              {driveSync.state.last_error && (
                <p className="mt-2 whitespace-pre-wrap text-danger">
                  {driveSync.state.last_error}
                </p>
              )}
            </div>

          {driveSync?.recent_files?.length ? (
            <div className="space-y-2">
              {driveSync.recent_files.slice(0, 4).map((file) => (
                <div
                  key={file.file_id}
                  className="rounded-md border border-line bg-surface px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">
                      {file.file_name || file.file_id}
                    </p>
                    <Badge tone={driveSyncTone(file.last_status as DriveSyncDiagnostics["state"]["status"])}>
                      {file.last_status === "applied"
                        ? "Хадгалсан"
                        : file.last_status === "unchanged"
                          ? "Өөрчлөлтгүй"
                          : file.last_status === "no_changes"
                            ? "Шинэ мэдээлэлгүй"
                            : file.last_status === "review_required"
                              ? "Шалгах"
                              : file.last_status === "error"
                                ? "Алдаа"
                                : "Алгассан"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {formatTime(file.updated_at)}
                  </p>
                  {file.last_error && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-danger">
                      {file.last_error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
      )}

      <Card className="p-4">
        <SectionHeading
          title="Үндсэн мэдээлэл"
          description={
            updatedAt
              ? `Шинэчилсэн: ${formatTime(updatedAt)}`
              : 'Бизнесийн нэр болон ботын үндсэн дүрэм.'
          }
          action={
            <Button size="sm" variant="ghost" onClick={onRequestClear}>
              Текст цэвэрлэх
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <Input
            label="Бизнесийн нэр"
            value={form.business_name}
            onChange={(e) => patch({ business_name: e.target.value })}
          />
          <Textarea
            label="Системийн зааварчилга"
            hint="Хэрэглэгчтэй харилцах ботын үндсэн дүрэм."
            rows={4}
            value={form.system_prompt}
            onChange={(e) => patch({ system_prompt: e.target.value })}
          />
          <Textarea
            label="Түлхүүр үгийн хариу"
            hint="Хэрэглэгч доорх түлхүүр үг бичвэл бот энэ хариуг автоматаар илгээнэ."
            rows={3}
            value={form.quick_info_reply}
            onChange={(e) => patch({ quick_info_reply: e.target.value })}
          />
          <Textarea
            label="Түлхүүр үгс"
            hint="Нэг мөрт нэг түлхүүр үг эсвэл хэллэг."
            rows={3}
            value={form.quick_info_keywords}
            onChange={(e) => patch({ quick_info_keywords: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Коммент автомат хариу"
          description="Facebook пост дээрх комментэд хариулах тохиргоо."
        />
        <div className="mt-3 space-y-3">
          <Textarea
            label="Коммент илэрхийлэх түлхүүр үгс"
            hint="Нэг мөрт нэг түлхүүр үг эсвэл хэллэг."
            rows={3}
            value={form.comment_trigger_patterns}
            onChange={(e) =>
              patch({ comment_trigger_patterns: e.target.value })
            }
          />
          <Textarea
            label="Нийтийн хариу (комментэд)"
            hint="Хэрэглэгчийн комментийн доор харагдах хариу."
            rows={2}
            value={form.comment_public_reply}
            onChange={(e) => patch({ comment_public_reply: e.target.value })}
          />
          <Textarea
            label="Хувийн мессеж (DM)"
            hint="Хэрэглэгчид шууд илгээх нууц хариу."
            rows={3}
            value={form.comment_dm_reply}
            onChange={(e) => patch({ comment_dm_reply: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Чатын товчлуурууд"
          description="Хэрэглэгч нэг дараад асуулт илгээдэг товч. Та хүссэн үедээ нэмэх, устгах, өөрчлөх боломжтой."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                patch({
                  chat_buttons: [
                    ...form.chat_buttons,
                    { label: "", message: "" },
                  ],
                })
              }
            >
              <Icons.plus size={15} />
              Товч нэмэх
            </Button>
          }
        />
        <div className="mt-3 space-y-2">
          {form.chat_buttons.length === 0 && (
            <div className="rounded-lg border border-dashed border-line-strong bg-surface-sunken px-4 py-5 text-center">
              <p className="text-sm font-medium text-ink-muted">Товч байхгүй байна</p>
              <p className="mt-1 text-xs text-ink-subtle">
                «Товч нэмэх» дарж эхлээрэй. Хэрэглэгч товч дарахад тухайн мессеж ботод илгээгдэнэ.
              </p>
            </div>
          )}
          {form.chat_buttons.map((btn, idx) => (
            <div
              key={idx}
              className="flex items-start gap-2 rounded-lg border border-line bg-surface p-3"
            >
              <div className="flex-1 space-y-2">
                <input
                  className="h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors focus:border-brand"
                  placeholder="Товчны нэр (хэрэглэгчид харагдана) — ж: Үнэ хэд вэ?"
                  value={btn.label}
                  maxLength={60}
                  onChange={(e) => {
                    const updated = form.chat_buttons.map((b, i) =>
                      i === idx ? { ...b, label: e.target.value } : b,
                    );
                    patch({ chat_buttons: updated });
                  }}
                />
                <input
                  className="h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors focus:border-brand"
                  placeholder="Илгээгдэх мессеж — ж: Хөх хот аяллын үнэ хэд вэ?"
                  value={btn.message}
                  maxLength={200}
                  onChange={(e) => {
                    const updated = form.chat_buttons.map((b, i) =>
                      i === idx ? { ...b, message: e.target.value } : b,
                    );
                    patch({ chat_buttons: updated });
                  }}
                />
              </div>
              <button
                type="button"
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger"
                onClick={() =>
                  patch({
                    chat_buttons: form.chat_buttons.filter((_, i) => i !== idx),
                  })
                }
                title="Устгах"
              >
                <Icons.trash size={16} />
              </button>
            </div>
          ))}
          {form.chat_buttons.length > 0 && (
            <p className="text-xs text-ink-subtle">
              Нийт {form.chat_buttons.length} товч · Дээрх мэдээллийг хадгалахаа мартуузай.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Хүнд шилжүүлэх"
          description="Хэрэглэгч ажилтантай ярихыг хүсвэл бот зогсож, та хариулна."
        />
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-sunken p-3">
            <span className="text-sm font-medium text-ink">
              Хүнд шилжүүлэх идэвхжүүлэх
            </span>
            <Switch
              checked={form.handoff_enabled}
              onChange={(next) => patch({ handoff_enabled: next })}
              label="Хүнд шилжүүлэх идэвхжүүлэх"
            />
          </div>
          <Textarea
            label="Илэрхийлэх түлхүүр үгс"
            hint="Хэрэглэгчийн мессежэд эдгээр үг байвал бот зогсч ажилтанд шилжинэ."
            rows={4}
            value={form.handoff_keywords}
            onChange={(e) => patch({ handoff_keywords: e.target.value })}
          />
          <Textarea
            label="Хэрэглэгчид илгээх хариу"
            rows={2}
            value={form.handoff_reply}
            onChange={(e) => patch({ handoff_reply: e.target.value })}
          />
          <Select
            label="Зогсоох хугацаа"
            hint="Тогтмол хугацаа сонгоно уу, эсвэл доорх минутын талбарт өөрийн утга оруулна уу."
            value={handoffDurationMode}
            onChange={(e) => {
              const next = e.target.value;
              patch({
                handoff_pause_minutes:
                  next === HANDOFF_DURATION_CUSTOM
                    ? form.handoff_pause_minutes
                    : next,
              });
            }}
          >
            {HANDOFF_DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={HANDOFF_DURATION_CUSTOM}>Өөр хугацаа</option>
          </Select>
          <Input
            label="Зогсоох минут"
            hint="Энэ хугацааны дараа бот автоматаар сэргэнэ. 0 оруулбал гараар сэргээх болно."
            inputMode="numeric"
            value={form.handoff_pause_minutes}
            onChange={(e) => patch({ handoff_pause_minutes: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Нэмэлт ботын мэдлэг"
          description="FAQ, тусгай санал, хөнгөлөлт, итгэмжлэл нэмэхийг хүсвэл нээнэ үү."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowOptionalData((prev) => !prev)}
            >
              {showOptionalData ? 'Нуух' : 'Нээх'}
            </Button>
          }
        />
        {showOptionalData ? (
          <div className="mt-3 space-y-3">
            <StructuredEditor
              title="Түгээмэл асуулт (FAQ)"
              addLabel="Асуулт нэмэх"
              fields={[
                { key: 'question', label: 'Асуулт' },
                { key: 'answer', label: 'Хариулт' },
              ]}
              rows={form.faq}
              onChange={(rows) => patch({ faq: rows })}
            />
            <StructuredEditor
              title="Тусгай санал"
              addLabel="Санал нэмэх"
              fields={[
                { key: 'name', label: 'Нэр' },
                { key: 'duration', label: 'Хугацаа' },
                { key: 'price', label: 'Үнэ' },
                { key: 'target', label: 'Зорилтот' },
                { key: 'eligibility', label: 'Нөхцөл' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.special_offers}
              onChange={(rows) => patch({ special_offers: rows })}
            />
            <StructuredEditor
              title="Хөнгөлөлтийн бодлого"
              addLabel="Хөнгөлөлт нэмэх"
              fields={[
                { key: 'name', label: 'Нэр' },
                { key: 'discount', label: 'Хөнгөлөлт' },
                { key: 'applies_to', label: 'Хамаарах' },
                { key: 'eligibility', label: 'Нөхцөл' },
                { key: 'verification', label: 'Баталгаажуулалт' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.discount_policies}
              onChange={(rows) => patch({ discount_policies: rows })}
            />
            <StructuredEditor
              title="Итгэмжлэл"
              addLabel="Итгэмжлэл нэмэх"
              fields={[
                { key: 'title', label: 'Гарчиг' },
                { key: 'issuer', label: 'Олгогч' },
                { key: 'issued_on', label: 'Олгосон огноо' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.verified_credentials}
              onChange={(rows) => patch({ verified_credentials: rows })}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            Хуудсыг энгийн байлгахын тулд нуусан. FAQ эсвэл тусгай санал нэмэхийг хүсвэл нээнэ үү.
          </p>
        )}
      </Card>

      <div className="sticky bottom-3 z-10 rounded-xl border border-line bg-surface/90 p-2 shadow-md backdrop-blur-md">
        <Button block size="lg" loading={busy} onClick={onSave}>
          Тохиргоо хадгалах
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white">
            <Icons.ai size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Бот туршиж үзэх</p>
            <p className="text-xs text-ink-muted">Хэрэглэгч шиг асуугаад хариуг шалгаарай</p>
          </div>
          <Badge tone="success" dot className="ml-auto shrink-0">
            Идэвхтэй
          </Badge>
        </div>
        <EmbeddedTestBot />
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------
   Embedded test bot (in SettingsTab) — Messenger style
   ---------------------------------------------------------------- */
type TestChatMsg = { from: "user" | "bot"; text: string };

const TEST_SUGGESTIONS = [
  "Хөх хот аяллын үнэ хэд вэ?",
  "Ирэх сард ямар аяллууд байгаа вэ?",
  "Суудал хэд үлдсэн бэ?",
  "Хоол багтдаг уу?",
];

function EmbeddedTestBot() {
  const [messages, setMessages] = useState<TestChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setConversationId(getTestBotConversationId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(textOverride?: string) {
    const payload = (textOverride ?? input).trim();
    if (!payload || sending || !conversationId) return;
    setMessages((prev) => [...prev, { from: "user", text: payload }]);
    setInput("");
    setSending(true);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload, conversationId }),
      });
      const json = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          from: "bot",
          text:
            typeof json?.reply === "string" && json.reply.trim()
              ? json.reply
              : "Хариу үүсгэх үед алдаа гарлаа.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: "Уучлаарай, сервертэй холбогдоход алдаа гарлаа." },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Suggestion chips */}
      <div className="scroll-area flex gap-2 overflow-x-auto border-b border-line bg-surface-sunken px-4 py-2.5">
        {TEST_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={sending || !conversationId}
            onClick={() => void send(s)}
            className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Message area */}
      <div className="scroll-area h-72 overflow-y-auto bg-surface-sunken px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Icons.ai size={24} />
            </div>
            <p className="text-sm text-ink-muted">
              Хэрэглэгч шиг асуулт бичээрэй — бот хэрхэн хариулахыг шалгаарай.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {messages.map((msg, i) => {
              const isUser = msg.from === "user";
              const showAvatar =
                !isUser &&
                (i === 0 || messages[i - 1]?.from === "user");
              return (
                <div
                  key={i}
                  className={cx(
                    "flex items-end gap-2",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  {!isUser && (
                    <div
                      className={cx(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white text-xs font-bold",
                        !showAvatar && "opacity-0",
                      )}
                    >
                      AI
                    </div>
                  )}
                  <div
                    className={cx(
                      "max-w-[75%] px-4 py-2.5 text-sm leading-relaxed",
                      isUser
                        ? "rounded-[20px] rounded-br-[4px] bg-brand text-white"
                        : "rounded-[20px] rounded-bl-[4px] bg-white text-ink shadow-sm",
                    )}
                  >
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="flex items-end gap-2 justify-start">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white text-xs font-bold">
                  AI
                </div>
                <div className="rounded-[20px] rounded-bl-[4px] bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-1">
                    {[0, 1, 2].map((n) => (
                      <span
                        key={n}
                        className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
                        style={{ animationDelay: `${n * 0.15}s` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar — Messenger style */}
      <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2.5">
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            title="Чат цэвэрлэх"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-subtle hover:bg-surface-sunken hover:text-ink"
          >
            <Icons.trash size={16} />
          </button>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void send(); }
          }}
          placeholder="Мессеж бичих…"
          disabled={sending || !conversationId}
          className="h-10 min-w-0 flex-1 rounded-full border border-line-strong bg-surface-sunken px-4 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:bg-surface focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          disabled={sending || !input.trim() || !conversationId}
          onClick={() => void send()}
          className={cx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
            input.trim() && !sending
              ? "bg-brand text-white hover:opacity-90"
              : "bg-surface-sunken text-ink-subtle cursor-not-allowed",
          )}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

