import Head from "next/head";
import { Button, Input, Logo, Spinner } from "@/components/ui";

/** /api/admin/google/callback sends the browser back with ?login_error=<code>. */
export const GOOGLE_LOGIN_ERRORS: Record<string, string> = {
  google_not_configured: "Google-ээр нэвтрэх тохиргоо хийгдээгүй байна.",
  google_state_mismatch: "Нэвтрэх хугацаа дууссан байна. Дахин оролдоно уу.",
  google_cancelled: "Google-ээр нэвтрэхийг цуцалсан.",
  google_exchange_failed: "Google-тэй холбогдож чадсангүй. Дахин оролдоно уу.",
  google_token_invalid: "Google нэвтрэлт баталгаажсангүй. Дахин оролдоно уу.",
  google_email_unverified: "Энэ Google хаягийн и-мэйл баталгаажаагүй байна.",
  google_email_not_allowed: "Энэ Google хаягаар нэвтрэх эрхгүй байна. Админд хандана уу.",
};

export function AdminLoginGate({
  checking,
  googleSignIn,
  secretDraft,
  onSecretDraftChange,
  onSubmit,
  busy,
  error,
}: {
  /** True while the page asks the server whether this browser is already signed in. */
  checking: boolean;
  /** Shows "Sign in with Google" when the server has it configured. */
  googleSignIn: boolean;
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
            {googleSignIn && (
              <>
                {/* An API route that redirects to Google: a full navigation, never a client-side <Link>. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/admin/google/start"
                  className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-line-strong bg-surface px-5 text-sm font-semibold text-ink shadow-xs transition-all duration-150 hover:border-ink-subtle hover:bg-surface-sunken/60 active:scale-[0.985]"
                >
                  <svg aria-hidden="true" viewBox="0 0 48 48" className="h-5 w-5">
                    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
                  </svg>
                  Google-ээр нэвтрэх
                </a>
                <div className="my-5 flex items-center gap-3 text-xs text-ink-muted">
                  <span className="h-px flex-1 bg-line" />
                  эсвэл нууц үгээр
                  <span className="h-px flex-1 bg-line" />
                </div>
              </>
            )}
            <form className={googleSignIn ? "space-y-4" : "mt-5 space-y-4"} onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}>
              <Input
                label="Админ нууц үг"
                type="password"
                autoComplete="current-password"
                required
                autoFocus={!googleSignIn}
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
