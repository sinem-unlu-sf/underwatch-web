import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BetaSignupForm } from "../components/landing/BetaSignupForm";
import { BETA_CTA, BETA_HREF, BUILT_WITH, FEATURES, FIXTURE_DEMO_HREF, HERO_SHOT, LANDING_ONLY, LIVE_DEMO_HREF, STEPS, type LandingShot } from "../components/landing/landingContent";
import { LogoMark } from "../components/shell/nav";

/**
 * Public landing page at "/" (rendered without the app shell). Every CTA goes to a real route:
 * /signup, /login, /overview (the app) and a real finding for the live demo. The static landing-only build
 * (LANDING_ONLY) has none of those routes, so its CTAs lead to the beta sign-up form in the final section instead.
 */
export function LandingPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Underwatch: verify what your coding agent did";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="kw-landing h-full overflow-y-auto bg-[#09090B] text-text" data-testid="landing-page">
      <a href="#landing-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-3 focus:py-2">
        Skip to content
      </a>
      <LandingNav />
      <main id="landing-main">
        <Hero />
        <FeatureSections />
        <HowItWorks />
        <BuiltWith />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}

const wrap = "mx-auto w-full max-w-[1200px] px-4 sm:px-6";
const ctaPrimary =
  "inline-flex h-10 items-center justify-center rounded-md bg-[#EDEDF0] px-4 text-[14px] font-medium text-[#09090B] transition-colors duration-150 hover:bg-white";
const ctaSecondary =
  "inline-flex h-10 items-center justify-center rounded-md border border-border-strong bg-white/[0.03] px-4 text-[14px] font-medium text-text transition-colors duration-150 hover:bg-white/[0.07]";

function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-[#09090B]/80 backdrop-blur-md">
      <div className={`${wrap} flex h-14 items-center justify-between gap-4`}>
        <Link to="/" className="flex items-center gap-2 rounded-sm text-[14px] font-semibold tracking-tight" aria-label="Underwatch home">
          <LogoMark size={22} />
          <span>Underwatch</span>
        </Link>
        <nav aria-label="Landing" className="hidden items-center gap-6 text-[13px] text-text-secondary md:flex">
          <a href="#features" className="hover:text-text">Product</a>
          <a href="#how-it-works" className="hover:text-text">How it works</a>
          {!LANDING_ONLY && <Link to="/overview" className="hover:text-text">Open the app</Link>}
        </nav>
        {LANDING_ONLY ? (
          <a href={BETA_HREF} className="inline-flex h-8 items-center rounded-md bg-[#EDEDF0] px-3 text-[13px] font-medium text-[#09090B] hover:bg-white">
            {BETA_CTA}
          </a>
        ) : (
        <div className="flex items-center gap-2">
          <Link to="/login" className="inline-flex h-8 items-center rounded-md px-3 text-[13px] text-text-secondary hover:text-text">
            Log in
          </Link>
          <Link to="/signup" className="inline-flex h-8 items-center rounded-md bg-[#EDEDF0] px-3 text-[13px] font-medium text-[#09090B] hover:bg-white">
            Sign up
          </Link>
        </div>
        )}
      </div>
    </header>
  );
}

function Shot({ shot, priority = false, className = "" }: { shot: LandingShot; priority?: boolean; className?: string }) {
  return (
    <figure className={className}>
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_24px_80px_rgba(0,0,0,0.55)]">
        <img
          src={shot.src}
          alt={shot.alt}
          width={shot.width}
          height={shot.height}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          className="block h-auto w-full max-w-full"
        />
      </div>
    </figure>
  );
}

/** Fades its children in once they scroll into view (immediately when IntersectionObserver or motion is unavailable). */
function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!el || reduced || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-300 ease-out ${shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"} ${className}`}
    >
      {children}
    </div>
  );
}

/** Small, slow-drifting glow behind the headline (decorative; stops under prefers-reduced-motion). */
function HeroMotion() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="kw-hero-orb kw-hero-orb-a" />
      <div className="kw-hero-orb kw-hero-orb-b" />
    </div>
  );
}

function Hero() {
  return (
    <>
      <section
        aria-labelledby="landing-hero-title"
        className="relative flex min-h-[calc(100dvh-56px)] items-center justify-center overflow-hidden"
      >
        <HeroMotion />
        <div className={`${wrap} relative flex flex-col items-center text-center`}>
          <h1
            id="landing-hero-title"
            className="text-[44px] font-semibold leading-none tracking-[-0.03em] sm:text-[56px] lg:text-[64px]"
          >
            Underwatch
          </h1>
          <p className="mt-5 max-w-[760px] text-[24px] leading-snug tracking-[-0.01em] sm:text-[30px] lg:text-[34px]">
            Your AI agents work. Under our watch.
          </p>
          <p className="mt-4 max-w-[620px] text-[15px] leading-relaxed text-text-secondary sm:text-[17px]">
            Independent observability and security for AI coding agents.
          </p>
        </div>
      </section>
      <section aria-label="Get started" className="relative">
        <div className={`${wrap} pb-16 pt-4`}>
          <Reveal className="flex flex-col items-center text-center">
        {LANDING_ONLY ? (
          <>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a href={BETA_HREF} className={ctaPrimary}>
              {BETA_CTA}
            </a>
            <a href="#how-it-works" className={ctaSecondary}>
              How it works
            </a>
          </div>
          <p className="mt-3 text-[12px] text-text-tertiary">
            For individuals and companies. We will email you as soon as the beta opens.
          </p>
          </>
        ) : (
        <>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link to="/signup" className={ctaPrimary}>
            Sign up
          </Link>
          <Link to="/overview" className={ctaSecondary}>
            Open the app
          </Link>
          <Link to={LIVE_DEMO_HREF} className={ctaSecondary}>
            Open live demo <span aria-hidden="true" className="ml-1.5">→</span>
          </Link>
          <Link to="/login" className="inline-flex h-10 items-center px-2 text-[14px] text-text-secondary hover:text-text">
            Log in
          </Link>
        </div>
        <p className="mt-3 text-[12px] text-text-tertiary">
          The live demo opens a real finding from a supervised run. Fixture example:{" "}
          <Link to={FIXTURE_DEMO_HREF} className="underline decoration-border-strong underline-offset-2 hover:text-text">
            fx-04 .env read via Bash
          </Link>
          .
        </p>
        </>
        )}
          </Reveal>
          <Reveal>
            <Shot shot={HERO_SHOT} className="mt-14 sm:mt-16" />
          </Reveal>
        </div>
      </section>
    </>
  );
}

function FeatureSections() {
  return (
    <div id="features" className="scroll-mt-16">
      {FEATURES.map((f, i) => (
        <section key={f.id} id={`feature-${f.id}`} aria-labelledby={`feature-${f.id}-title`} className="border-t border-border">
          <div className={`${wrap} grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14`}>
            <div className={i % 2 === 1 ? "lg:order-2" : ""}>
              <p className="text-[13px] font-medium text-accent">{f.eyebrow}</p>
              <h2 id={`feature-${f.id}-title`} className="mt-3 text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">
                {f.title}
              </h2>
              <p className="mt-4 text-[15px] leading-relaxed text-text-secondary">{f.body}</p>
              <ul className="mt-6 space-y-2.5 text-[14px] text-fg-1">
                {f.points.map((p) => (
                  <li key={p} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-text-secondary" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Shot shot={f.shot} className={i % 2 === 1 ? "lg:order-1" : ""} />
          </div>
        </section>
      ))}
    </div>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-16 border-t border-border">
      <div className={`${wrap} py-16 sm:py-24`}>
        <h2 id="how-title" className="text-[28px] font-semibold tracking-[-0.02em] sm:text-[34px]">
          How it works
        </h2>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="bg-[#0C0C0F] p-6">
              <span className="font-mono text-[12px] text-text-tertiary">{s.n}</span>
              <h3 className="mt-3 text-[16px] font-medium">{s.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function BuiltWith() {
  return (
    <section aria-labelledby="built-title" className="border-t border-border">
      <div className={`${wrap} flex flex-col gap-5 py-12 sm:flex-row sm:items-center sm:justify-between`}>
        <h2 id="built-title" className="text-[13px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
          Built with
        </h2>
        <ul className="flex flex-wrap gap-x-10 gap-y-3 text-[17px] font-medium tracking-tight text-text-secondary">
          {BUILT_WITH.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section id={LANDING_ONLY ? "beta" : undefined} aria-labelledby="final-cta-title" className="relative scroll-mt-16 overflow-hidden border-t border-border">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(50% 80% at 50% 100%, rgba(139,140,246,0.12) 0%, rgba(9,9,11,0) 70%)" }}
      />
      <div className={`${wrap} relative py-20 text-center sm:py-28`}>
        <h2 id="final-cta-title" className="mx-auto max-w-[720px] text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">
          Don't just trust what your coding agent says it did.
        </h2>
        {LANDING_ONLY ? (
          <BetaSignupForm />
        ) : (
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/signup" className={ctaPrimary}>
            Sign up
          </Link>
          <Link to={LIVE_DEMO_HREF} className={ctaSecondary}>
            Open live demo
          </Link>
          <Link to="/overview" className={ctaSecondary}>
            Open the app
          </Link>
        </div>
        )}
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-border">
      <div className={`${wrap} flex flex-col gap-4 py-8 text-[12px] text-text-tertiary sm:flex-row sm:items-center sm:justify-between`}>
        <div className="flex items-center gap-2">
          <LogoMark size={18} />
          <span>Underwatch</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          {LANDING_ONLY ? (
            <>
            <a href="#features" className="hover:text-text">Product</a>
            <a href="#how-it-works" className="hover:text-text">How it works</a>
            <a href={BETA_HREF} className="hover:text-text">{BETA_CTA}</a>
            </>
          ) : (
          <>
          <Link to="/overview" className="hover:text-text">Overview</Link>
          <Link to="/findings" className="hover:text-text">Findings</Link>
          <Link to="/runs" className="hover:text-text">Agent Runs</Link>
          <Link to="/safeguards" className="hover:text-text">Safeguards</Link>
          <Link to="/login" className="hover:text-text">Log in</Link>
          <Link to="/signup" className="hover:text-text">Sign up</Link>
          </>
          )}
        </nav>
      </div>
    </footer>
  );
}
