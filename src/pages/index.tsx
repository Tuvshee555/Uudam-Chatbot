import DemoChat from "@/components/DemoChat";
import { Badge, Button, Card, Icons } from "@/components/ui";
import Head from "next/head";

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas px-4 py-6 md:px-8 md:py-8">
      <Head>
        <title>Уудам Трэвел AI Туслах</title>
        <meta
          name="description"
          content="Уудам Трэвелийн AI туслах: маршрут, үнэ, гарах өдөр, суудлын үлдэгдэл болон аяллын мэдээлэлд хурдан хариулна."
        />
      </Head>

      <main className="mx-auto max-w-6xl space-y-6">
        <Card className="overflow-hidden">
          <div className="bg-linear-to-br from-brand to-brand-hover px-6 py-8 text-white md:px-8 md:py-10">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <Badge tone="neutral" className="bg-white/12 text-white">
                  Уудам Трэвел
                </Badge>
                <h1 className="mt-5 text-3xl font-semibold tracking-tight md:text-4xl">
                  Аяллын мэдээлэлд шууд, ойлгомжтой хариулах AI туслах
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  Маршрут, үнэ, гарах өдөр, суудлын үлдэгдэл болон аяллын гол
                  мэдээллийг бодит өгөгдөл дээр тулгуурлан хурдан шалгах туршилтын орчин.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  href="#demo-chat"
                  size="lg"
                  className="border-white/20 bg-white text-brand hover:bg-white/92"
                >
                  <Icons.play size={16} />
                  Шууд турших
                </Button>
                <Button
                  href="/admin"
                  variant="secondary"
                  size="lg"
                  className="border-white/20 bg-white/10 text-white hover:bg-white/16"
                >
                  Удирдлагын самбар
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 border-t border-line bg-surface px-6 py-5 md:grid-cols-3 md:px-8">
            {[
              {
                title: "Бодит өгөгдөл",
                body: "Үнэ, суудал, гарах өдөр зэрэг мэдээллийг туршилтын чатаар хурдан шалгана.",
              },
              {
                title: "Монгол хэлний хариулт",
                body: "Хэрэглэгчийн асуултад монгол хэлээр товч, ойлгомжтой байдлаар хариулна.",
              },
              {
                title: "Админ хяналт",
                body: "Аялал шинэчлэх, AI санал шалгах, ботын төлөвийг удирдах боломжтой.",
              },
            ].map((item) => (
              <div key={item.title} className="rounded-lg border border-line bg-canvas/65 p-4">
                <p className="text-sm font-semibold text-ink">{item.title}</p>
                <p className="mt-1 text-sm leading-6 text-ink-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card id="demo-chat" className="p-6 md:p-8">
          <div className="max-w-2xl">
            <Badge tone="brand">Шууд демо</Badge>
            <h2 className="mt-3 text-2xl font-semibold text-ink">
              Хариултын чанарыг шууд шалга
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              Хэрэглэгч яг юу асуух байсан тэр хэлбэрээр бичээд бот ямар хариу
              өгөхийг бодитоор туршаарай.
            </p>
          </div>
          <div className="mt-5">
            <DemoChat />
          </div>
        </Card>
      </main>
    </div>
  );
}
