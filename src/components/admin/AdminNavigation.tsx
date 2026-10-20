import { useEffect } from "react";
import { Logo, Modal, cx } from "@/components/ui";
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
      <nav aria-label="Удирдлагын цэс" className="space-y-6">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 px-3 text-[10.5px] font-bold uppercase tracking-[0.08em] text-nav-ink-soft/70">
              {group.label}
            </p>
            <div className="space-y-0.5">
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
          "scroll-area-dark hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-nav-line bg-nav lg:w-64",
          !desktopHidden && "md:flex",
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b border-nav-line px-5">
          <Logo tone="inverse" className="min-w-0" />
        </div>
        <div className="flex-1 px-3 py-5">{links()}</div>
        <p className="shrink-0 border-t border-nav-line px-5 py-3 text-[11px] text-nav-ink-soft">
          Таны өөрчлөлт хадгалахаас өмнө хянагдана
        </p>
      </aside>
      <Modal
        open={mobileOpen}
        onClose={onClose}
        title="Удирдлагын цэс"
        panelClassName="max-w-sm"
      >
        <div className="-m-1 rounded-xl bg-nav p-3">{links()}</div>
      </Modal>
    </>
  );
}
