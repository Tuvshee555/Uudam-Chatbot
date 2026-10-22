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
    <div className="relative flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Head>
        <title>Админ — нэвтрэх</title>
      </Head>
      <div className="animate-fade-up relative w-full max-w-sm">
        <div className="rounded-xl border border-line bg-surface p-7 shadow-sm">
          <Logo />
          <h1 className="mt-6 text-xl font-bold tracking-tight text-ink">
            Удирдлагын самбар
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Үргэлжлүүлэхийн тулд админ нууц үгээ оруулна уу.
          </p>
          <form className="mt-5 space-y-4" onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}>
            <Input
              label="Админ нууц үг"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={secretDraft}
              onChange={(event) => onSecretDraftChange(event.target.value)}
            />
            <Button block size="lg" type="submit" disabled={!secretDraft.trim()}>
              Нэвтрэх
            </Button>
          </form>
        </div>
        <p className="mt-5 text-center text-xs text-ink-muted">
          Уудам Трэвэл · Аяллын AI туслах
        </p>
      </div>
    </div>
  );
}
