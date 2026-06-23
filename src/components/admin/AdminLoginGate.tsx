import Head from "next/head";
import { Button, Card, Input } from "@/components/ui";

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
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <Head>
        <title>Админ - нэвтрэх</title>
      </Head>
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-ink">Админ удирдлага</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Үргэлжлүүлэхийн тулд админ нууц үгээ оруулна уу.
        </p>
        <div className="mt-4 space-y-3">
          <Input
            type="password"
            placeholder="Админ нууц үг"
            value={secretDraft}
            onChange={(event) => onSecretDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
            }}
          />
          <Button block onClick={onSubmit}>
            Нэвтрэх
          </Button>
        </div>
      </Card>
    </div>
  );
}
