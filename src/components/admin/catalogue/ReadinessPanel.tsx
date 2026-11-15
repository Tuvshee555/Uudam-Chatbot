import { Badge, Card } from "@/components/ui";
import type { CatalogueReadiness, CatalogueReadinessStatus } from "@/lib/catalogue/admin/types";

const TONE: Record<CatalogueReadinessStatus, "success" | "warning" | "danger"> = { green: "success", amber: "warning", red: "danger" };
const STATUS_LABEL: Record<CatalogueReadinessStatus, string> = { green: "Бэлэн", amber: "Анхаар", red: "Засах" };
const OVERALL_TEXT: Record<CatalogueReadinessStatus, string> = {
  green: "Нийтлэхэд бэлэн: шалгах зүйл бүгд хэвийн.",
  amber: "Нийтлэх боломжтой, гэхдээ доорх зүйлсийг нэг харна уу.",
  red: "Нийтлэхээс өмнө засах зүйл байна.",
};

/**
 * The "before publishing" checklist at the head of the tab. Every row is green / amber / red with what was found and
 * the one next step. The list is open whenever something is not green; when all is well it folds into one line.
 */
export function ReadinessPanel({ readiness }: { readiness: CatalogueReadiness }) {
  const notGreen = readiness.items.filter((item) => item.status !== "green").length;
  return (
    <Card className="p-4" aria-label="Нийтлэхээс өмнөх шалгалт">
      <details open={notGreen > 0}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm font-semibold text-ink">
          <Badge tone={TONE[readiness.overall]} dot>{STATUS_LABEL[readiness.overall]}</Badge>
          <span>Нийтлэхээс өмнөх шалгалт</span>
          <span className="font-normal text-ink-muted">{OVERALL_TEXT[readiness.overall]}</span>
        </summary>
        <ul className="mt-3 divide-y divide-line" aria-label="Шалгалтын жагсаалт">
          {readiness.items.map((item) => (
            <li key={item.id} data-status={item.status} className="flex flex-wrap items-start gap-3 py-2.5">
              <Badge tone={TONE[item.status]} dot className="mt-0.5 shrink-0">{STATUS_LABEL[item.status]}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">{item.label}</span>
                <span className="block text-sm text-ink-muted">{item.detail}</span>
                {item.next && <span className="block text-sm text-ink">→ {item.next}</span>}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
