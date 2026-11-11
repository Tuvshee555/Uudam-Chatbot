/**
 * The bar at the top of the new-trip review: what stops a publish or a save (red), what deserves a
 * look (amber), each a link that opens the place to fix it; a calm green «Нийтлэхэд бэлэн» when
 * nothing does. The list is tripReviewProblems.reviewProblems, the save gate's own checks.
 */
import { Icons, cx } from "@/components/ui";
import type { ReviewProblem, ReviewProblems } from "@/lib/tripReviewProblems";

export function ReviewProblemsBar({ problems, onGo, showAll, onShowAll, onOpenEditor, disabled }: {
  problems: ReviewProblems;
  onGo: (problem: ReviewProblem) => void;
  showAll: boolean;
  onShowAll: (next: boolean) => void;
  /** Opens the trip in the full trip editor (discounts, extra fees, settings …). */
  onOpenEditor?: () => void;
  disabled?: boolean;
}) {
  const { blocking, warnings } = problems;
  const saveBlocked = blocking.some((problem) => problem.blocks === "save");
  const items = [...blocking, ...warnings];
  return (
    <section aria-label="Шалгах зүйлс" className={cx("rounded-xl border",
      blocking.length ? "border-danger/25 bg-danger-soft/25" : warnings.length ? "border-warning/30 bg-warning-soft/30" : "border-success/25 bg-success-soft/40")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
        <p className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-2 gap-y-0.5 text-[15px] leading-6" role="status" aria-live="polite">
          {blocking.length ? (
            <>
              <span className="flex items-center gap-2 font-semibold text-danger">
                <Icons.alert size={17} className="shrink-0" /> Нийтлэхийн өмнө {blocking.length} зүйл засна
              </span>
              {!saveBlocked && <span className="text-sm text-ink-muted">Ноорог болгон хадгалж болно.</span>}
            </>
          ) : (
            <>
              <span className="flex items-center gap-2 font-semibold text-success">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white"><Icons.check size={12} /></span>
                Нийтлэхэд бэлэн
              </span>
              <span className="text-sm text-ink-muted">{warnings.length ? `${warnings.length} зүйлийг нэг харчихаарай.` : "Дутуу зүйл алга."}</span>
            </>
          )}
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          <button type="button" aria-pressed={showAll} onClick={() => onShowAll(!showAll)}
            title="Хоосон талбаруудыг бүгдийг харуулах"
            className={cx("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors",
              showAll ? "border-brand bg-brand-soft text-brand" : "border-line-strong bg-surface text-ink-muted hover:border-brand hover:text-ink")}>
            <span className={cx("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", showAll ? "border-brand bg-brand text-white" : "border-line-strong bg-surface")}>
              {showAll && <Icons.check size={10} />}
            </span>
            Бүх талбар
          </button>
          {onOpenEditor && (
            <button type="button" disabled={disabled} onClick={onOpenEditor} title="Хямдрал, нэмэлт төлбөр, вэбсайтын талбар, тохиргоо"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-ink transition-colors hover:border-brand disabled:opacity-50">
              <Icons.edit size={13} /> Бүтэн засварлагч
            </button>
          )}
        </span>
      </div>
      {items.length > 0 && (
        <ul className="border-t border-line/70 py-1">
          {items.map((problem) => {
            const block = problem.blocks !== null;
            const body = (
              <>
                <span className={cx("mt-[7px] h-2 w-2 shrink-0 rounded-full", block ? "bg-danger" : "bg-sun")} aria-hidden="true" />
                <span className={cx("min-w-0 flex-1 whitespace-pre-line text-[15px] leading-6", block ? "text-ink" : "text-ink")}>
                  <span className="sr-only">{block ? "Засах: " : "Шалгах: "}</span>{problem.text}
                </span>
                {problem.target && (
                  <span className={cx("mt-0.5 flex shrink-0 items-center gap-0.5 text-[13px] font-semibold", block ? "text-danger" : "text-brand")}>
                    {block ? "Засах" : "Харах"} <Icons.chevronRight size={13} />
                  </span>
                )}
              </>
            );
            return (
              <li key={problem.id}>
                {problem.target ? (
                  <button type="button" onClick={() => onGo(problem)} data-problem={problem.id}
                    className={cx("flex w-full items-start gap-3 px-4 py-2 text-left transition-colors sm:px-5", block ? "hover:bg-danger-soft/60" : "hover:bg-warning-soft/60")}>
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-2 sm:px-5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
