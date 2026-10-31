import Head from "next/head";
import { Button, Input, Logo, Spinner } from "@/components/ui";

export function AdminLoginGate({
  checking,
  secretDraft,
  onSecretDraftChange,
  onSubmit,
  busy,
  error,
}: {
  /** True while the page asks the server whether this browser is already signed in. */
  checking: boolean;
  secretDraft: string;
  onSecretDraftChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string;
}) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Head>
        <title>Админ — нэвтрэх</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {checking ? (
        <div role="status" className="flex flex-col items-center gap-3 text-sm text-ink-muted">
          <Spinner className="h-6 w-6 text-brand" />
          Нэвтрэлтийг шалгаж байна…
        </div>
      ) : (
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
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "admin-login-error" : undefined}
                onChange={(event) => onSecretDraftChange(event.target.value)}
              />
              {error && (
                <p id="admin-login-error" role="alert" className="text-sm font-medium text-danger">
                  {error}
                </p>
              )}
              <Button block size="lg" type="submit" loading={busy} disabled={!secretDraft.trim() || busy}>
                Нэвтрэх
              </Button>
            </form>
            <p className="mt-4 text-xs text-ink-muted">
              Энэ төхөөрөмж 7 хоног нэвтэрсэн хэвээр байна. Нийтийн компьютер дээр ажлаа дуусгаад «Гарах» дарна уу.
            </p>
          </div>
          <p className="mt-5 text-center text-xs text-ink-muted">
            Уудам Трэвэл · Аяллын AI туслах
          </p>
        </div>
      )}
    </div>
  );
}
