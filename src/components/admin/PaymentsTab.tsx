import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "@/components/ui";
import type {
  AIAction,
  AIProposal,
  AttachedFile,
  ChatButton,
  ChatMessage,
  ClarificationAnswer,
  ClarificationQuestion,
  ConflictItem,
  ControlState,
  DriveSyncDiagnostics,
  DriveSyncRecentFile,
  FlowRule,
  LeadStats,
  PageControlState,
  PauseRow,
  ProposalMsg,
  ReadinessReport,
  RecentRow,
  SettingsForm,
  StructuredRow,
  TravelBotSettings,
  TravelLead,
  TravelTrip,
} from "@/lib/adminTypes";
import {
  FIELD_LABELS,
  STATUS_LABELS,
  buildProposalClarifications,
  compactWarnings,
  describeAction,
  summarizeConflict,
} from "@/lib/adminProposalUtils";
import { SectionHeading, StructuredEditor } from "./AdminShared";
import {
  PAYMENT_STATUS_MN,
  PAYMENT_STATUS_TONE,
  type PaymentRow,
  type PaymentStats,
} from "./adminTabData";
import {
  DURATIONS,
  HANDOFF_DURATION_CUSTOM,
  HANDOFF_DURATION_OPTIONS,
  MAX_AI_INPUT_CHARS,
  QUICK_ACTIONS,
  STATUS_TONE,
  asInt,
  conflictTone,
  driveSyncTone,
  formatBytes,
  formatMoney,
  formatTime,
  handoffDurationSelectValue,
  settingsToForm,
  shortId,
  splitLines,
  timeLeft,
  toStructuredRows,
} from "@/lib/adminUtils";

export function PaymentsTab({
  apiFetch,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const toast = useToast();
  const [configured, setConfigured] = useState(false);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [stats, setStats] = useState<PaymentStats>({ total: 0, paid: 0, pending: 0, paidAmount: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/payments");
      const data = await res.json();
      setConfigured(Boolean(data?.configured));
      setPayments(Array.isArray(data?.payments) ? data.payments : []);
      if (data?.stats) setStats(data.stats);
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
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeading
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
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Нийт</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.total}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Төлсөн</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.paid}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Хүлээгдэж буй</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.pending}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Нийт орлого</p>
          <p className="mt-1 text-2xl font-bold text-ink">
            {stats.paidAmount.toLocaleString()}₮
          </p>
        </Card>
      </div>

      {/* Payments table */}
      <Card className="p-4">
        <SectionHeading title="Төлбөрийн түүх" description="Хэн юунд төлсөн, юу хүлээгдэж байгаа." />
        {payments.length === 0 ? (
          <EmptyState
            icon={<Icons.download size={28} />}
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
                      {p.trip_name || "—"} · {p.amount.toLocaleString()}
                      {p.currency === "MNT" ? "₮" : ` ${p.currency}`}
                    </p>
                    <p className="text-xs text-ink-subtle">{formatTime(p.created_at)}</p>
                  </div>
                  <Badge tone={PAYMENT_STATUS_TONE[p.status]}>
                    {PAYMENT_STATUS_MN[p.status]}
                  </Badge>
                </div>
                {p.status !== "paid" && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void setStatus(p.id, "paid")}
                      className="rounded-md border border-success/40 bg-success-soft px-2 py-1 text-xs font-medium text-success hover:border-success disabled:opacity-50"
                    >
                      Төлсөн гэж тэмдэглэх
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void setStatus(p.id, "cancelled")}
                      className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-ink-muted hover:border-danger hover:text-danger disabled:opacity-50"
                    >
                      Цуцлах
                    </button>
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

/* ----------------------------------------------------------------
   Flow Builder Tab — keyword-triggered bot replies
   ---------------------------------------------------------------- */
const BLANK_FLOW_RULE: Omit<FlowRule, "id"> = {
  keywords: "",
  reply: "",
  buttons: [],
};
