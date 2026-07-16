import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, useToast } from "@/components/ui";
import { LoadingPanel, SectionHeading, StatCard, TabHeader } from "./AdminShared";
import {
  PAYMENT_STATUS_MN,
  PAYMENT_STATUS_TONE,
  type PaymentRow,
  type PaymentStats,
} from "./adminTabData";
import { formatTime, shortId } from "@/lib/adminUtils";

// Survives tab switches: revisits render the last data instantly while a
// background refresh replaces it, instead of a spinner on every visit.
let paymentsCache: {
  configured: boolean;
  payments: PaymentRow[];
  stats: PaymentStats;
} | null = null;

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
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (paymentsCache == null) setLoading(true);
    try {
      const res = await apiFetch("/api/admin/payments");
      const data = await res.json();
      const nextConfigured = Boolean(data?.configured);
      const nextPayments = Array.isArray(data?.payments) ? data.payments : [];
      setConfigured(nextConfigured);
      setPayments(nextPayments);
      if (data?.stats) setStats(data.stats);
      paymentsCache = {
        configured: nextConfigured,
        payments: nextPayments,
        stats: data?.stats ?? { total: 0, paid: 0, pending: 0, paidAmount: 0 },
      };
    } catch {
      toast.error("Төлбөрийн мэдээлэл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: number, status: PaymentRow["status"]) {
    setBusyId(id);
    try {
      const res = await apiFetch("/api/admin/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) {
        toast.error("Шинэчилж чадсангүй.");
        return;
      }
      await load();
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
        description="QPay-ээр төлбөр хүлээн авах болон төлбөрийн түүх. Одоогоор унтраалттай."
      />

      {/* Feature status banner */}
      {!configured ? (
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
          <div className="mt-3 space-y-2">
            {payments.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-line bg-surface-sunken p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {p.customer_name || shortId(p.sender_id) || "Тодорхойгүй"}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {p.trip_name || "—"} · {p.amount.toLocaleString("en-US")}
                      {p.currency === "MNT" ? "₮" : ` ${p.currency}`}
                    </p>
                    <p className="text-xs text-ink-subtle">{formatTime(p.created_at)}</p>
                  </div>
                  <Badge tone={PAYMENT_STATUS_TONE[p.status]}>
                    {PAYMENT_STATUS_MN[p.status]}
                  </Badge>
                </div>
                {p.status !== "paid" && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="success"
                      disabled={busyId === p.id}
                      onClick={() => void setStatus(p.id, "paid")}
                    >
                      <Icons.check size={14} />
                      Төлсөн гэж тэмдэглэх
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      disabled={busyId === p.id}
                      onClick={() => void setStatus(p.id, "cancelled")}
                    >
                      Цуцлах
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

