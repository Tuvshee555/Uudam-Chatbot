import type { ReactNode } from "react";
import { Icons, cx } from "@/components/ui";
import type { TabKey } from "@/lib/adminTypes";

/** Grouped nav for the admin rail — one place to add or reorder tabs. */
export const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ key: TabKey; label: string; icon: ReactNode }>;
}> = [
  {
    label: "Үндсэн",
    items: [
      { key: "assistant", label: "AI туслах", icon: <Icons.ai size={16} /> },
      { key: "trips", label: "Аяллууд", icon: <Icons.trips size={16} /> },
    ],
  },
  {
    label: "Контент",
    items: [
      { key: "greeting", label: "Мэндчилгээ", icon: <Icons.bot size={16} /> },
      { key: "seasons", label: "Улирал", icon: <Icons.refresh size={16} /> },
      { key: "photos", label: "Зураг оруулах", icon: <Icons.upload size={16} /> },
      { key: "poster", label: "Постер үүсгэгч", icon: <Icons.image size={16} /> },
    ],
  },
  {
    label: "Харилцагч",
    items: [
      { key: "bot", label: "Ботын хяналт", icon: <Icons.control size={16} /> },
      { key: "leads", label: "Хүсэлтүүд", icon: <Icons.user size={16} /> },
      { key: "documents", label: "Ирсэн зургууд", icon: <Icons.file size={16} /> },
    ],
  },
  {
    label: "Систем",
    items: [
      { key: "settings", label: "Тохиргоо", icon: <Icons.settings size={16} /> },
      { key: "analytics", label: "Аналитик", icon: <Icons.chart size={16} /> },
      { key: "flow", label: "Урсгал", icon: <Icons.play size={16} /> },
      { key: "payments", label: "Төлбөр", icon: <Icons.card size={16} /> },
      { key: "json", label: "JSON засвар", icon: <Icons.braces size={16} /> },
    ],
  },
];

/** One row of the light admin nav rail. */
export function AdminSidebarItem({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-all duration-150",
        active
          ? "bg-brand-soft text-brand"
          : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "absolute left-0 top-1/2 h-4.5 w-[3px] -translate-y-1/2 rounded-full bg-brand transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      <span
        className={cx(
          "shrink-0 transition-colors",
          active ? "text-brand" : "text-ink-subtle",
        )}
      >
        {icon}
      </span>
      <span className="flex-1 truncate text-left">{label}</span>
      {badge != null && badge > 0 && (
        <span className="min-w-5 rounded-full bg-danger px-1.5 py-0.5 text-center text-[10px] font-bold tabular-nums text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
