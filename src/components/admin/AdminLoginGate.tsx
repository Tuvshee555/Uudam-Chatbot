import Head from "next/head";
import { Button, Input, Logo } from "@/components/ui";

export function AdminLoginGate({
  secretDraft,
  onSecretDraftChange,
  onSubmit,
}: {
  secretDraft: string;
  onSecretDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-nav-deep px-4 py-10">
      <Head>
        <title>Админ — нэвтрэх</title>
      </Head>
      {/* Ambient brand glow over the deep navy backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(760px 500px at 78% -10%, rgba(23, 82, 127, 0.55), transparent 65%)," +
            "radial-gradient(620px 460px at -8% 108%, rgba(22, 134, 139, 0.28), transparent 60%)",
        }}
      />
      <div className="animate-fade-up relative w-full max-w-sm">
        <div className="rounded-xl border border-white/10 bg-surface p-7 shadow-lg">
          <Logo />
          <h1 className="mt-6 text-xl font-bold tracking-tight text-ink">
            Удирдлагын самбар
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Үргэлжлүүлэхийн тулд админ нууц үгээ оруулна уу.
          </p>
          <div className="mt-5 space-y-3">
            <Input
              type="password"
              placeholder="Админ нууц үг"
              autoFocus
              value={secretDraft}
              onChange={(event) => onSecretDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
              }}
            />
            <Button block size="lg" onClick={onSubmit}>
              Нэвтрэх
            </Button>
          </div>
        </div>
        <p className="mt-5 text-center text-xs text-nav-ink-soft">
          Уудам Трэвэл · Аяллын AI туслах
        </p>
      </div>
    </div>
  );
}
