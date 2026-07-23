import Head from "next/head";
import { useEffect, useRef, useState, type ReactNode } from "react";
import DemoChat from "@/components/DemoChat";
import { Badge, Icons, cx } from "@/components/ui";

/* ------------------------------------------------------------------
   Freelance service landing page.

   The hero's visual asset is the REAL, live Uudam bot (DemoChat), not
   a stock photo or a fake screenshot. It is the product and the proof
   in one. Light theme, locked. Reuses the app's design tokens so the
   page stays coherent with the admin + demo surfaces.

   NOTE: wordmark, name, and the mailto address below are yours to edit.
   ------------------------------------------------------------------ */

const CONTACT_EMAIL = "ganturtuvshinsaihan@gmail.com";
const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  "Chatbot for my business",
)}`;

const CTA_PRIMARY =
  "inline-flex h-11 items-center justify-center gap-2 rounded-md bg-brand px-5 text-sm font-semibold text-white shadow-xs shadow-brand/30 transition-all duration-150 hover:bg-brand-hover active:scale-[0.985]";
const CTA_SECONDARY =
  "inline-flex h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-5 text-sm font-semibold text-ink transition-all duration-150 hover:border-brand-border hover:bg-brand-soft/40 active:scale-[0.985]";

/* Scroll-reveal wrapper. Reveals once on entering the viewport; snaps
   straight to visible under reduced-motion or if IntersectionObserver
   is unavailable, so content is never trapped hidden. */
function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // Progressive-enhancement fallback: no observer support, reveal at once
      // so content is never trapped hidden.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown(true);
      return;
    }
    // Reduced-motion still reveals here; the globals.css reduced-motion block
    // zeroes the transition so it snaps in instead of sliding.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
      className={cx(
        "transition-all duration-700 ease-out will-change-transform",
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SectionHeading({
  title,
  intro,
}: {
  title: string;
  intro?: string;
}) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
        {title}
      </h2>
      {intro && (
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">{intro}</p>
      )}
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-hover via-brand to-brand-active text-white shadow-sm shadow-brand/30"
          >
            <Icons.bot size={18} />
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">
            Tuvshin
          </span>
        </a>
        <nav className="flex items-center gap-6">
          <a
            href="#how"
            className="hidden text-sm font-medium text-ink-muted transition-colors hover:text-ink sm:block"
          >
            How it works
          </a>
          <a href={CONTACT_HREF} className={cx(CTA_PRIMARY, "h-10 px-4")}>
            Hire me
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1.04fr_0.96fr] lg:gap-14 lg:py-24">
        <div className="animate-fade-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-border bg-brand-soft px-3 py-1 text-xs font-semibold text-brand">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
            </span>
            Freelance chatbot developer
          </span>
          <h1 className="mt-5 text-4xl font-extrabold leading-[1.04] tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Chatbots that don&apos;t lie to your customers.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
            Messenger and Instagram bots for travel and e-commerce. They answer
            from your real data and hand off to a human instead of guessing.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={CONTACT_HREF} className={CTA_PRIMARY}>
              Hire me
              <Icons.chevronRight size={16} />
            </a>
            <a href="#how" className={CTA_SECONDARY}>
              See how it works
            </a>
          </div>
          <p className="mt-6 text-sm text-ink-subtle">
            The chat on this page is a real bot, live for a travel agency. Try
            it.
          </p>
        </div>

        <div className="animate-fade-up [animation-delay:130ms]">
          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute -inset-4 -z-10 rounded-[28px] bg-gradient-to-br from-brand-soft via-sun-soft/50 to-transparent blur-2xl"
            />
            <DemoChat showHeader={false} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Differentiator() {
  const points = [
    {
      icon: <Icons.database size={20} />,
      title: "Answers only from your data",
      body: "No invented prices, dates, or routes. If it is not in your catalog, the bot does not make it up.",
    },
    {
      icon: <Icons.user size={20} />,
      title: "Hands off to a real person",
      body: "The moment it is not sure, it routes the customer to your staff instead of guessing an answer.",
    },
    {
      icon: <Icons.check size={20} />,
      title: "Never fakes a confirmation",
      body: "It will not tell a customer a payment or booking is confirmed. Only your team can do that.",
    },
  ];
  return (
    <section className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <Reveal>
          <SectionHeading
            title="Most bots make things up. This one refuses to."
            intro="The fastest way to lose a customer is a confident wrong answer. This bot only says what is actually in your data, and asks a human when it is not sure."
          />
        </Reveal>
        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
          {points.map((point, i) => (
            <Reveal key={point.title} delay={i * 80}>
              <div className="flex h-full flex-col gap-3 bg-surface p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand">
                  {point.icon}
                </span>
                <h3 className="mt-1 text-base font-semibold text-ink">
                  {point.title}
                </h3>
                <p className="text-sm leading-relaxed text-ink-muted">
                  {point.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Services() {
  return (
    <section className="border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <Reveal>
          <SectionHeading title="What I build" />
        </Reveal>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <Reveal className="md:col-span-2">
            <div className="card-lift flex h-full flex-col justify-between gap-8 rounded-2xl bg-gradient-to-br from-nav via-nav to-nav-raised p-8 text-nav-ink">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-white">
                <Icons.bot size={20} />
              </span>
              <div>
                <h3 className="text-xl font-semibold text-white">
                  Sales assistants that actually know your catalog
                </h3>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-nav-ink-soft">
                  They answer product, trip, price, and schedule questions in
                  your customer&apos;s own language, around the clock.
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="card-lift flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sun-soft text-sun">
                <Icons.send size={20} />
              </span>
              <h3 className="mt-1 text-base font-semibold text-ink">
                Lead capture
              </h3>
              <p className="text-sm leading-relaxed text-ink-muted">
                Grabs the phone number and pings you the moment someone is ready
                to buy.
              </p>
            </div>
          </Reveal>

          <Reveal>
            <div className="card-lift flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Icons.database size={20} />
              </span>
              <h3 className="mt-1 text-base font-semibold text-ink">
                Trained on your data
              </h3>
              <p className="text-sm leading-relaxed text-ink-muted">
                Your real products, prices, and policies. Not a generic model
                guessing.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80} className="md:col-span-2">
            <div className="card-lift flex h-full flex-col justify-between gap-6 rounded-2xl border border-brand-border bg-brand-soft/60 p-8 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-lg font-semibold text-ink">
                  Live where your customers already are
                </h3>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
                  Facebook Messenger, Instagram, and web chat, all answering
                  from the same source of truth.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface text-brand shadow-xs">
                  <Icons.send size={20} />
                </span>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface text-brand shadow-xs">
                  <Icons.image size={20} />
                </span>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface text-brand shadow-xs">
                  <Icons.control size={20} />
                </span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function CaseStudy() {
  const chips = ["Live on Messenger", "Answers in Mongolian", "Refuses to guess prices"];
  return (
    <section className="border-t border-line bg-surface-sunken">
      <div className="mx-auto max-w-3xl px-5 py-20 text-center sm:px-8">
        <Reveal>
          <Badge tone="brand">Case study</Badge>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            The bot on this page is real.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-ink-muted">
            It is live on Facebook Messenger for Uudam Travel, a Mongolian
            agency. It answers trip, price, and schedule questions from their
            real catalog, captures phone leads, and routes anything it cannot
            verify to their staff. Scroll up and try it. That is the actual bot.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {chips.map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted"
              >
                <Icons.check size={13} className="text-brand" />
                {chip}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Process() {
  const steps = [
    {
      title: "Share your catalog",
      body: "Send me your products or trips, prices, and the questions customers actually ask you.",
    },
    {
      title: "I build and tune it",
      body: "I wire it to your data, set the guardrails, and test it against real questions until it answers cleanly.",
    },
    {
      title: "It goes live on your channels",
      body: "Connected to your Messenger and Instagram, answering customers and capturing leads.",
    },
  ];
  return (
    <section id="how" className="border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <Reveal>
          <SectionHeading title="How we'd work" />
        </Reveal>
        <ol className="mt-12 space-y-px overflow-hidden rounded-xl border border-line bg-line">
          {steps.map((step, i) => (
            <Reveal key={step.title} delay={i * 70}>
              <li className="flex flex-col gap-4 bg-surface p-7 sm:flex-row sm:items-center sm:gap-8">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-brand-border bg-brand-soft text-base font-bold text-brand">
                  {i + 1}
                </span>
                <div className="min-w-0 sm:flex-1">
                  <h3 className="text-lg font-semibold text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                    {step.body}
                  </p>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-line bg-surface">
      <div className="mx-auto max-w-3xl px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Want one for your business?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-ink-muted">
            Tell me what you sell and I will show you what your bot could answer.
          </p>
          <div className="mt-8 flex justify-center">
            <a href={CONTACT_HREF} className={cx(CTA_PRIMARY, "h-12 px-6 text-base")}>
              Hire me
              <Icons.chevronRight size={18} />
            </a>
          </div>
          <p className="mt-4 text-sm text-ink-subtle">{CONTACT_EMAIL}</p>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-nav text-nav-ink-soft">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-10 sm:flex-row sm:px-8">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white"
          >
            <Icons.bot size={16} />
          </span>
          <span className="text-sm font-semibold text-nav-ink">
            Chatbots for travel &amp; e-commerce
          </span>
        </div>
        <a
          href={CONTACT_HREF}
          className="text-sm font-medium text-nav-ink transition-colors hover:text-white"
        >
          {CONTACT_EMAIL}
        </a>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <>
      <Head>
        <title>Chatbot developer for travel &amp; e-commerce</title>
        <meta
          name="description"
          content="I build Messenger and Instagram chatbots for travel and e-commerce that answer from your real data and hand off to a human instead of guessing."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <main className="min-h-[100dvh]">
        <Nav />
        <Hero />
        <Differentiator />
        <Services />
        <CaseStudy />
        <Process />
        <FinalCta />
        <Footer />
      </main>
    </>
  );
}
