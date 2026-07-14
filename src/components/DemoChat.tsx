import { useEffect, useRef, useState } from "react";
import { Badge, Button, Icons, cx } from "@/components/ui";

type PinnedButton = { label: string; message: string };

type ChatMessage = {
  from: "user" | "bot";
  text: string;
  aiButtons?: string[];
  mediaUrls?: string[];
  brochureUrl?: string | null;
};

type DemoChatProps = {
  className?: string;
  title?: string;
  description?: string;
  showHeader?: boolean;
  placeholder?: string;
};

const DEMO_CONVERSATION_KEY = "uudam_demo_conversation_id";

function getConversationId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.sessionStorage.getItem(DEMO_CONVERSATION_KEY);
  if (existing) return existing;
  const nextId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
  window.sessionStorage.setItem(DEMO_CONVERSATION_KEY, nextId);
  return nextId;
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}

export default function DemoChat({
  className,
  title = "Шууд хариулт шалгах",
  description = "Хэрэглэгчийн асуултаар туршаад ботын бодит хариуг шууд шалгана.",
  showHeader = true,
  placeholder = "Маршрут, үнэ, гарах өдөр, хоол, суудлын талаар асуугаарай...",
}: DemoChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [pinnedButtons, setPinnedButtons] = useState<PinnedButton[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConversationId(getConversationId());
    fetch("/api/demo")
      .then((r) => r.json())
      .then((json) => {
        if (Array.isArray(json?.pinned_buttons)) {
          setPinnedButtons(
            (json.pinned_buttons as unknown[]).filter(
              (b): b is PinnedButton =>
                b !== null &&
                typeof b === "object" &&
                typeof (b as PinnedButton).label === "string" &&
                typeof (b as PinnedButton).message === "string" &&
                (b as PinnedButton).label.trim().length > 0,
            ),
          );
        }
      })
      .catch(() => {});
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
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload, conversationId }),
      });
      const json = await response.json();
      const replyText =
        typeof json?.reply === "string" && json.reply.trim()
          ? json.reply
          : "Хариу боловсруулах үед алдаа гарлаа.";
      const aiButtons: string[] = Array.isArray(json?.buttons)
        ? (json.buttons as unknown[]).filter(
            (b): b is string => typeof b === "string",
          )
        : [];
      const mediaUrls: string[] = Array.isArray(json?.mediaUrls)
        ? (json.mediaUrls as unknown[]).filter(
            (url): url is string => typeof url === "string" && url.startsWith("https://"),
          )
        : [];
      const brochureUrl =
        typeof json?.brochureUrl === "string" && json.brochureUrl.startsWith("https://")
          ? json.brochureUrl
          : null;
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: replyText, aiButtons, mediaUrls, brochureUrl },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: "Уучлаарай, сервертэй холбогдоход алдаа гарлаа." },
      ]);
    } finally {
      setSending(false);
    }
  }

  const hasPinned = pinnedButtons.length > 0;

  return (
    <div className={cx("space-y-4", className)}>
      {showHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            <p className="mt-1 text-sm text-ink-muted">{description}</p>
          </div>
          <Badge tone="brand">Бодит хариулт</Badge>
        </div>
      )}

      <div className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-sm">
        {/* Bot header */}
        <div className="border-b border-line bg-linear-to-r from-brand-soft via-surface to-surface px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
              <Icons.ai size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Уудам Трэвел AI</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Аялалын асуултад шууд хариулна
              </p>
            </div>
            <span className="ml-auto flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Онлайн
            </span>
          </div>
        </div>

        {/* Pinned quick-action buttons — always visible */}
        {hasPinned && (
          <div className="border-b border-line bg-surface-sunken px-4 py-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
              Түгээмэл асуултууд
            </p>
            <div className="flex flex-wrap gap-2">
              {pinnedButtons.map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  disabled={sending || !conversationId}
                  onClick={() => void send(btn.message)}
                  className="rounded-full border border-brand/30 bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand transition-all hover:border-brand hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message area */}
        <div
          aria-live="polite"
          className="scroll-area overflow-y-auto bg-canvas/55 px-4 py-4"
          style={{ height: hasPinned ? "22rem" : "26rem" }}
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[18px] border border-dashed border-line-strong bg-surface px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
                <Icons.ai size={20} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-ink">
                  {hasPinned
                    ? "Дээрх товч дарж эхлэх эсвэл өөрийн асуултаа бичнэ үү"
                    : "Одоогоор мессеж алга"}
                </p>
                <p className="max-w-md text-sm text-ink-muted">
                  Үнэ, суудал, гарах өдөр, хоол эсвэл маршруттай холбоотой
                  бодит асуултаар туршаарай.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((msg, idx) => (
                <div
                  key={`${msg.from}-${idx}`}
                  className={cx(
                    "flex flex-col",
                    msg.from === "user" ? "items-end" : "items-start",
                  )}
                >
                  <div
                    className={cx(
                      "max-w-[88%] rounded-[20px] px-4 py-3 text-sm leading-relaxed shadow-sm",
                      msg.from === "user"
                        ? "rounded-br-md bg-brand text-white"
                        : "rounded-bl-md border border-line bg-surface text-ink",
                    )}
                  >
                    {msg.text}
                  </div>
                  {msg.from === "bot" && ((msg.mediaUrls?.length || 0) > 0 || msg.brochureUrl) && (
                    <div className="mt-2 flex max-w-[88%] flex-col gap-2">
                      {msg.mediaUrls && msg.mediaUrls.length > 0 && (
                        <div className="grid grid-cols-2 gap-2">
                          {msg.mediaUrls.map((url, imageIndex) => (
                            <a
                              key={`${url}-${imageIndex}`}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="block overflow-hidden rounded-lg border border-line bg-surface shadow-sm"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- Demo chat previews arbitrary media URLs returned by the bot. */}
                              <img
                                src={url}
                                alt={`Trip photo ${imageIndex + 1}`}
                                className="aspect-4/3 w-full object-cover"
                                loading="lazy"
                              />
                            </a>
                          ))}
                        </div>
                      )}
                      {msg.brochureUrl && (
                        <a
                          href={msg.brochureUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex w-fit items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-brand shadow-sm transition-colors hover:border-brand"
                        >
                          <Icons.file size={14} />
                          PDF
                        </a>
                      )}
                    </div>
                  )}
                  {/* AI-generated contextual follow-up buttons */}
                  {msg.from === "bot" &&
                    msg.aiButtons &&
                    msg.aiButtons.length > 0 && (
                      <div className="mt-2 flex max-w-[88%] flex-wrap gap-1.5">
                        {msg.aiButtons.map((label) => (
                          <button
                            key={label}
                            type="button"
                            disabled={sending || !conversationId}
                            onClick={() => void send(label)}
                            className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-[20px] rounded-bl-md border border-line bg-surface px-3 py-2 shadow-sm">
                    <TypingDots />
                  </div>
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div className="border-t border-line bg-surface px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              id="demo-chat-input"
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              className="flex-1 resize-none rounded-2xl border border-line-strong bg-surface-sunken px-4 py-3 text-sm leading-relaxed text-ink transition-colors placeholder:text-ink-subtle focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={sending || !conversationId}
              style={{ minHeight: "44px" }}
            />
            <Button
              size="md"
              loading={sending}
              disabled={sending || !input.trim() || !conversationId}
              onClick={() => void send()}
              className="shrink-0 rounded-2xl"
            >
              <Icons.play size={15} />
              Илгээх
            </Button>
          </div>
          <p className="mt-1.5 text-center text-xs text-ink-subtle">
            Enter — илгээх · Shift+Enter — шинэ мөр
          </p>
        </div>
      </div>
    </div>
  );
}
