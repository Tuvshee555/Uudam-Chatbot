import { useEffect } from "react";
import { Icons, Logo, Modal, cx } from "@/components/ui";
import type { TabKey } from "@/lib/adminTypes";
import { AdminSidebarItem, NAV_GROUPS } from "./AdminSidebarItem";

export function AdminNavigation({
  tab,
  badges,
  mobileOpen,
  desktopHidden,
  onClose,
  onSelect,
  onSignOut,
}: {
  tab: TabKey;
  badges: Partial<Record<TabKey, number>>;
  mobileOpen: boolean;
  desktopHidden: boolean;
  onClose: () => void;
  onSelect: (tab: TabKey) => void;
  onSignOut: () => void;
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
            <p className="mb-1.5 px-3 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-muted">
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

  const signOutButton = (
    <button
      type="button"
      onClick={onSignOut}
      className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-brand"
    >
      <Icons.logout size={16} />
      Гарах
    </button>
  );

  return (
    <>
      <aside
        id="admin-navigation"
        aria-label="Удирдлагын хэсгүүд"
        className={cx(
          "scroll-area hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface lg:w-64",
          !desktopHidden && "md:flex",
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b border-line px-5">
          <Logo className="min-w-0" />
        </div>
        <div className="flex-1 px-3 py-5">{links()}</div>
        <div className="shrink-0 border-t border-line px-3 py-2">{signOutButton}</div>
      </aside>
      <Modal
        open={mobileOpen}
        onClose={onClose}
        title="Удирдлагын цэс"
        panelClassName="max-w-sm"
      >
        <div className="-m-1 space-y-3 rounded-xl bg-surface p-3">
          {links()}
          <div className="border-t border-line pt-2">{signOutButton}</div>
        </div>
      </Modal>
    </>
  );
}
