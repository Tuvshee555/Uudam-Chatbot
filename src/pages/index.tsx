import DemoChat from "@/components/DemoChat";
import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen px-4 py-8 md:px-8">
      <Head>
        <title>Уудам Трэвел AI Туслах</title>
      </Head>
      <main className="mx-auto max-w-5xl space-y-6">
        <section className="glass-card p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700">
                Уудам Трэвел
              </p>
              <h1 className="mt-1 text-3xl font-semibold text-slate-900">AI Туслах Туршилт</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-600">
                Маршрут, үнэ, суудлын үлдэгдэл, аяллын мэдээлэлд бодит цагийн өгөгдлөөр
                хариулдаг туршилтын чат.
              </p>
            </div>
            <Link href="/admin" className="btn-primary inline-flex items-center justify-center">
              Удирдлагын Самбар Нээх
            </Link>
          </div>
        </section>

        <section className="glass-card p-6">
          <h2 className="section-title">Шууд Чат</h2>
          <p className="section-subtitle">Асуултаа бичээд шууд хариу туршаарай.</p>
          <div className="mt-4">
            <DemoChat />
          </div>
        </section>
      </main>
    </div>
  );
}
