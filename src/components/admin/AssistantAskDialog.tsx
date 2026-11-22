/**
 * Several questions the assistant asks at once, as one dialog: a tab per question, the question
 * with what it found, choices that say what they do (the recommended one first), "Өөр" to type an
 * answer of one's own, and one button that sends every answer together.
 *
 * Why (owner, 2026-11-21): a package of files needs several decisions — a price, a transport, how
 * to show a list — and the assistant used to ask one bare question at a time, or none. He wanted
 * the questions the way a careful colleague would put them: all on the table, each with its
 * options explained, nothing saved until he has answered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import { dialogAnswer, type DialogPicks } from "./assistantChatLogic";
import type { AssistantAskMsg } from "./assistantChatTypes";

export function AssistantAskDialog({ message, busy, onSubmit }: {
  message: AssistantAskMsg;
  busy: boolean;
  onSubmit: (message: AssistantAskMsg, picks: DialogPicks) => void;
}) {
  const questions = useMemo(() => message.questions || [], [message.questions]);
  const [active, setActive] = useState(0);
  const [picks, setPicks] = useState<DialogPicks>({});
  // The questions answered with words of one's own ("Өөр"): their input stays open.
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const done = Boolean(message.answered);
  const question = questions[Math.min(active, questions.length - 1)];
  const answeredIds = questions.filter((entry) => {
    const pick = picks[entry.id];
    return Boolean(pick && (String(pick.text || "").trim() || typeof pick.option === "number"));
  }).map((entry) => entry.id);
  const ready = dialogAnswer(message, picks) !== null;
  const typingNow = question ? Boolean(typing[question.id]) : false;

  useEffect(() => {
    if (typingNow) inputRef.current?.focus();
  }, [typingNow, active]);

  if (!question) return null;

  // Answered: the dialog reads as history — each heading with what was chosen.
  if (done) {
    return (
      <div className="w-full min-w-0 max-w-3xl rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3.5 shadow-xs" role="group" aria-label="Туслахын асуултууд (хариулсан)">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{questions.length} асуулт · хариулсан</p>
        <dl className="mt-2 space-y-1.5">
          {(message.dialogAnswers || []).map((entry) => (
            <div key={entry.header} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <dt className="flex shrink-0 items-center gap-1.5 text-ink-muted"><Icons.check size={13} className="text-success" />{entry.header}</dt>
              <dd className="min-w-0 font-medium text-ink wrap-break-word">{entry.answer}</dd>
            </div>
          ))}
          {!(message.dialogAnswers || []).length && <p className="text-sm text-ink-muted">Таны хариулт: <span className="font-medium text-ink">{message.answered}</span></p>}
        </dl>
      </div>
    );
  }

  const goNext = (from: number, nextPicks: DialogPicks) => {
    // The next question still open, looking forward first.
    const order = [...questions.slice(from + 1), ...questions.slice(0, from + 1)];
    const open = order.find((entry) => {
      const pick = nextPicks[entry.id];
      return !(pick && (String(pick.text || "").trim() || typeof pick.option === "number"));
    });
    if (open) setActive(questions.indexOf(open));
  };
  const choose = (index: number) => {
    if (busy) return;
    const nextPicks = { ...picks, [question.id]: { option: index } };
    setPicks(nextPicks);
    setTyping((prev) => ({ ...prev, [question.id]: false }));
    goNext(active, nextPicks);
  };
  const openOther = () => {
    if (busy) return;
    setTyping((prev) => ({ ...prev, [question.id]: true }));
    setPicks((prev) => ({ ...prev, [question.id]: { text: prev[question.id]?.text || "" } }));
  };
  const pick = picks[question.id] || {};

  return (
    <div className="w-full min-w-0 max-w-3xl overflow-hidden rounded-2xl rounded-bl-md border border-brand-border bg-surface shadow-xs" role="group" aria-label="Туслахын асуултууд">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 pt-2" role="tablist" aria-label="Асуултууд">
        {questions.map((entry, index) => {
          const answered = answeredIds.includes(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={cx(
                "-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors",
                index === active ? "border-brand text-ink" : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {answered && <Icons.check size={13} className="text-success" />}
              {entry.header}
            </button>
          );
        })}
      </div>

      <div className="px-4 pt-3.5 pb-3" role="tabpanel">
        <p className="whitespace-pre-line text-[15px] font-semibold leading-6 text-ink">{question.text}</p>
        <ul className="mt-3 space-y-1.5" role="radiogroup" aria-label={question.header}>
          {question.options.map((option, index) => {
            const chosen = !typingNow && pick.option === index;
            return (
              <li key={`${question.id}-${index}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  disabled={busy}
                  onClick={() => choose(index)}
                  className={cx(
                    "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-wait disabled:opacity-60",
                    chosen ? "border-brand bg-brand-soft" : "border-line bg-surface hover:border-brand hover:bg-brand-soft/50",
                  )}
                >
                  <span className={cx("mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", chosen ? "border-brand bg-brand" : "border-line-strong bg-surface")} aria-hidden="true">
                    {chosen && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-ink wrap-break-word">{option.label}</span>
                      {option.recommended && <span className="rounded-full bg-success-soft px-2 py-px text-[11px] font-semibold text-success">Санал болгож буй</span>}
                    </span>
                    {option.description && <span className="mt-0.5 block text-[13px] leading-5 text-ink-muted wrap-break-word">{option.description}</span>}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <div className={cx("rounded-xl border px-3 py-2.5 transition-colors", typingNow ? "border-brand bg-brand-soft" : "border-line bg-surface hover:border-brand hover:bg-brand-soft/50")}>
              <button type="button" role="radio" aria-checked={typingNow} disabled={busy} onClick={openOther} className="flex w-full items-start gap-3 text-left disabled:cursor-wait disabled:opacity-60">
                <span className={cx("mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", typingNow ? "border-brand bg-brand" : "border-line-strong bg-surface")} aria-hidden="true">
                  {typingNow && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{question.custom_label || "Өөр"}</span>
                  {!typingNow && <span className="mt-0.5 block text-[13px] leading-5 text-ink-muted">{question.custom_placeholder ? `Бичнэ: ${question.custom_placeholder}` : "Хариултаа өөрийн үгээр бичнэ (ж: үнэ, тайлбар)."}</span>}
                </span>
              </button>
              {typingNow && (
                <input
                  ref={inputRef}
                  type="text"
                  value={pick.text || ""}
                  disabled={busy}
                  onChange={(event) => setPicks((prev) => ({ ...prev, [question.id]: { text: event.target.value } }))}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    if (String(pick.text || "").trim()) goNext(active, picks);
                  }}
                  maxLength={600}
                  placeholder={question.custom_placeholder || "Хариултаа бичнэ үү…"}
                  aria-label={`${question.header}: өөрийн хариулт`}
                  className="mt-2 ml-7 block w-[calc(100%-1.75rem)] rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle"
                />
              )}
            </div>
          </li>
        </ul>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-canvas/60 px-4 py-2.5">
        <p className="text-xs text-ink-muted" aria-live="polite">
          {answeredIds.length}/{questions.length} хариулсан{ready ? " — илгээхэд бэлэн" : ""}. Илгээх хүртэл юу ч хадгалагдахгүй.
        </p>
        <div className="flex items-center gap-2">
          {questions.length > 1 && (
            <Button size="sm" variant="ghost" disabled={busy || active === 0} onClick={() => setActive((value) => Math.max(0, value - 1))}>
              <Icons.chevronLeft size={14} /> Өмнөх
            </Button>
          )}
          {questions.length > 1 && active < questions.length - 1 && !ready && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setActive((value) => Math.min(questions.length - 1, value + 1))}>
              Дараагийн <Icons.chevronRight size={14} />
            </Button>
          )}
          <Button size="sm" disabled={busy || !ready} onClick={() => onSubmit(message, picks)}>
            <Icons.send size={14} /> {questions.length > 1 ? "Хариултуудыг илгээх" : "Хариултыг илгээх"}
          </Button>
        </div>
      </div>
    </div>
  );
}
