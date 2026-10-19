import { useEffect } from "react";
import { Modal, cx } from "@/components/ui";
import type { TabKey } from "@/lib/adminTypes";
import { AdminSidebarItem, NAV_GROUPS } from "./AdminSidebarItem";

export function AdminNavigation({
  tab,
  badges,
  mobileOpen,
  desktopHidden,
  onClose,
  onSelect,
}: {
  tab: TabKey;
  badges: Partial<Record<TabKey, number>>;
  mobileOpen: boolean;
  desktopHidden: boolean;
  onClose: () => void;
  onSelect: (tab: TabKey) => void;
}) {
  useEffect(() => {
    if (!mobileOpen) return;
    const media = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (media.matches) onClose();
    };
    closeOnDesktop();
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, [mobileOpen, onClose]);

  function links() {
    return (
      <nav aria-label="Удирдлагын цэс" className="space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-2 px-3 text-[11px] font-semibold tracking-wide text-ink-muted">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => (
                <AdminSidebarItem
                  key={item.key}
                  icon={item.icon}
                  label={item.label}
                  active={tab === item.key}
                  badge={badges[item.key]}
                  onClick={() => onSelect(item.key)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <>
      <aside
        id="admin-navigation"
        aria-label="Удирдлагын хэсгүүд"
        className={cx(
          "scroll-area hidden w-60 shrink-0 overflow-y-auto border-r border-line bg-surface/90 px-3 py-5 lg:w-64",
          !desktopHidden && "md:block",
        )}
      >
        {links()}
      </aside>
      <Modal
        open={mobileOpen}
        onClose={onClose}
        title="Удирдлагын цэс"
        panelClassName="max-w-sm"
      >
        {links()}
      </Modal>
    </>
  );
}
