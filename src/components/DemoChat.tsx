import { useEffect, useRef, useState } from "react";

type ChatMessage = {
  from: "user" | "bot";
  text: string;
};

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-1 py-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
          style={{ animationDelay: `${index * 0.12}s` }}
        />
      ))}
    </div>
  );
}

export default function DemoChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send() {
    const payload = input.trim();
    if (!payload || sending) return;

    setMessages((prev) => [...prev, { from: "user", text: payload }]);
    setInput("");
    setSending(true);
    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      const json = await response.json();
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
    }
  }

  return (
    <div className="space-y-3">
      <div className="h-[26rem] overflow-auto rounded-2xl border border-slate-200 bg-white p-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-500">
            Сайн байна уу? Жишээ нь: “Хөх хот аяллын үнэ ба үлдсэн суудал хэд вэ?”
          </p>
        )}
        <div className="space-y-2">
          {messages.map((message, index) => (
            <div
              key={`${message.from}-${index}`}
              className={message.from === "user" ? "text-right" : "text-left"}
            >
              <div
                className={
                  message.from === "user"
                    ? "inline-block max-w-[85%] rounded-2xl rounded-br-sm bg-sky-600 px-3 py-2 text-sm text-white"
                    : "inline-block max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-800"
                }
              >
                {message.text}
              </div>
            </div>
          ))}
          {sending && (
            <div className="text-left">
              <div className="inline-block rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2">
                <TypingDots />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_auto]">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="input-field min-h-14 resize-y"
          placeholder="Хөтөлбөр, маршрут, үнэ, суудлын үлдэгдлийн талаар асуугаарай..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={sending}
        />
        <button
          onClick={() => void send()}
          className="btn-primary h-fit px-4 py-3"
          disabled={sending || !input.trim()}
        >
          {sending ? "Илгээж байна..." : "Илгээх"}
        </button>
      </div>
    </div>
  );
}
