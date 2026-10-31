import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, Modal, useToast } from "@/components/ui";
import { LoadingPanel, SectionHeading, StatCard, TabHeader } from "./AdminShared";
import {
  PAYMENT_STATUS_MN,
  PAYMENT_STATUS_TONE,
  type PaymentRow,
  type PaymentStats,
} from "./adminTabData";
import { ensureOk, formatTime, shortId } from "@/lib/adminUtils";

// Survives tab switches: revisits render the last data instantly while a
// background refresh replaces it, instead of a spinner on every visit.
let paymentsCache: {
  configured: boolean;
  payments: PaymentRow[];
  stats: PaymentStats;
} | null = null;

type PendingChange = { payment: PaymentRow; status: "paid" | "cancelled" };

function money(payment: PaymentRow): string {
  return `${payment.amount.toLocaleString("en-US")}${payment.currency === "MNT" ? "₮" : ` ${payment.currency}`}`;
}

export function PaymentsTab({
  apiFetch,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const toast = useToast();
  const [configured, setConfigured] = useState(paymentsCache?.configured ?? false);
  const [payments, setPayments] = useState<PaymentRow[]>(paymentsCache?.payments ?? []);
  const [stats, setStats] = useState<PaymentStats>(
    paymentsCache?.stats ?? { total: 0, paid: 0, pending: 0, paidAmount: 0 },
  );
  const [loading, setLoading] = useState(paymentsCache == null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);

  const load = useCallback(async () => {
    if (paymentsCache == null) setLoading(true);
    try {
      // A failed load must not read as "QPay is off and there are no payments".
      const data = await ensureOk<{ configured?: boolean; payments?: unknown; stats?: PaymentStats }>(
        await apiFetch("/api/admin/payments"), "Төлбөрийн мэдээлэл ачаалж чадсангүй.");
      const nextConfigured = Boolean(data?.configured);
      const nextPayments = Array.isArray(data?.payments) ? data.payments as PaymentRow[] : [];
      setConfigured(nextConfigured);
      setPayments(nextPayments);
      if (data?.stats) setStats(data.stats);
      setLoadFailed(false);
      paymentsCache = {
        configured: nextConfigured,
        payments: nextPayments,
        stats: data?.stats ?? { total: 0, paid: 0, pending: 0, paidAmount: 0 },
      };
    } catch (err) {
      setLoadFailed(true);
      toast.error(err instanceof Error ? err.message : "Төлбөрийн мэдээлэл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Changes a payment's status after the confirmation dialog; reports only what the server confirmed. */
  async function applyStatus(change: PendingChange) {
    setBusyId(change.payment.id);
    try {
      await ensureOk(await apiFetch("/api/admin/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: change.payment.id, status: change.status }),
      }), "Төлбөрийн төлөвийг шинэчилж чадсангүй.");
      toast.success(change.status === "paid" ? "Төлсөн гэж тэмдэглэлээ." : "Төлбөрийг цуцаллаа.");
      setPendingChange(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Төлбөрийн төлөвийг шинэчилж чадсангүй.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <LoadingPanel />;
  }

  return (
    <div className="space-y-6">
      <TabHeader
        icon={<Icons.card size={20} />}
        title="Төлбөр (QPay)"
        description={configured
          ? "QPay-ээр хүлээн авсан болон хүлээгдэж буй төлбөрийн түүх."
          : "QPay-ээр төлбөр хүлээн авах болон төлбөрийн түүх. Одоогоор унтраалттай."}
      />

      {loadFailed && (
        <Alert tone="danger">
          Төлбөрийн мэдээллийг ачаалж чадсангүй. Доорх тоо хамгийн сүүлд амжилттай ачаалсан мэдээлэл байж болно.{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()}>Дахин оролдох</button>
        </Alert>
      )}

      {/* Feature status banner */}
      {loadFailed ? null : !configured ? (
        <Alert tone="info">
          <span className="font-medium">QPay идэвхгүй байна.</span>{" "}
          Идэвхжүүлэхийн тулд серверийн орчинд{" "}
          <code className="rounded bg-surface-sunken px-1 text-xs">QPAY_ENABLED=true</code>{" "}
          болон QPay-ийн түлхүүрүүдийг (QPAY_BASE_URL, QPAY_USERNAME, QPAY_PASSWORD,
          QPAY_INVOICE_CODE) тохируулна уу. Түлхүүр бэлэн болоход энэ хэсэг автоматаар асна.
          Бот QPay идэвхгүй үед түүний талаар огт мэдэхгүй.
        </Alert>
      ) : (
        <Alert tone="success">
          <span className="font-medium">QPay идэвхтэй.</span> Төлбөр хүлээн авах боломжтой.
        </Alert>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Нийт" value={stats.total} />
        <StatCard label="Төлсөн" value={stats.paid} tone="text-success" />
        <StatCard label="Хүлээгдэж буй" value={stats.pending} tone="text-warning" />
        <StatCard label="Нийт орлого" value={`${stats.paidAmount.toLocaleString("en-US")}₮`} />
      </div>

      {/* Payments table */}
      <Card className="p-4">
        <SectionHeading title="Төлбөрийн түүх" description="Хэн юунд төлсөн, юу хүлээгдэж байгаа." />
        {payments.length === 0 ? (
          <EmptyState
            icon={<Icons.card size={24} />}
            title="Төлбөр алга"
            description="Одоогоор бүртгэгдсэн төлбөр байхгүй байна."
          />
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {p.customer_name || shortId(p.sender_id) || "Тодорхойгүй"}
                  </p>
                  <p className="truncate text-xs text-ink-muted">
                    {p.trip_name || "Аялал заагаагүй"} · <span className="tabular-nums">{money(p)}</span> · {formatTime(p.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Badge tone={PAYMENT_STATUS_TONE[p.status]}>{PAYMENT_STATUS_MN[p.status]}</Badge>
                  {/* An expired invoice can still be settled by bank transfer, so any unpaid row can be marked paid. */}
                  {p.status !== "paid" && (
                    <Button size="sm" variant="secondary" disabled={busyId === p.id}
                      onClick={() => setPendingChange({ payment: p, status: "paid" })}>
                      <Icons.check size={14} />
                      Төлсөн гэж тэмдэглэх
                    </Button>
                  )}
                  {p.status !== "paid" && p.status !== "cancelled" && (
                    <Button size="sm" variant="ghost" className="text-danger" disabled={busyId === p.id}
                      onClick={() => setPendingChange({ payment: p, status: "cancelled" })}>
                      Цуцлах
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={pendingChange != null}
        onClose={() => { if (busyId == null) setPendingChange(null); }}
        title={pendingChange?.status === "paid" ? "Төлсөн гэж тэмдэглэх үү?" : "Төлбөрийг цуцлах уу?"}
        description={pendingChange?.status === "paid"
          ? "Мөнгө данс руу орсныг шалгасны дараа л тэмдэглэнэ үү. Энэ нь тайланд орлого болж бүртгэгдэнэ."
          : "Цуцалсан төлбөрийг дахин төлөх боломжгүй болно."}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={busyId != null} onClick={() => setPendingChange(null)}>Болих</Button>
            <Button
              variant={pendingChange?.status === "paid" ? "success" : "danger"}
              loading={busyId != null}
              onClick={() => pendingChange && void applyStatus(pendingChange)}
            >
              {pendingChange?.status === "paid" ? "Төлсөн гэж тэмдэглэх" : "Цуцлах"}
            </Button>
          </div>
        }
      >
        {pendingChange && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-muted">Харилцагч</dt>
            <dd className="text-ink">{pendingChange.payment.customer_name || shortId(pendingChange.payment.sender_id) || "Тодорхойгүй"}</dd>
            <dt className="text-ink-muted">Аялал</dt>
            <dd className="text-ink">{pendingChange.payment.trip_name || "Аялал заагаагүй"}</dd>
            <dt className="text-ink-muted">Дүн</dt>
            <dd className="font-semibold tabular-nums text-ink">{money(pendingChange.payment)}</dd>
          </dl>
        )}
      </Modal>
    </div>
  );
}
