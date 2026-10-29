import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { BetaSignupForm } from "../components/landing/BetaSignupForm";
import { EyeGarden } from "../components/landing/EyeGarden";
import { IntroAnimation, shouldPlayIntro } from "../components/landing/IntroAnimation";
import { OrbitalEvidence } from "../components/landing/OrbitalEvidence";
import { EyeFlowerCluster } from "../components/landing/LandingAccents";
import { ChecklistCharacter, CompareCharacter, InvestigateCharacter, ObserverCharacter, SafeguardCharacter } from "../components/landing/LandingCharacters";
import { BETA_CTA, BETA_HREF, FEATURES, FIXTURE_DEMO_HREF, HERO_SHOT, LANDING_ONLY, LIVE_DEMO_HREF, STEPS, type LandingShot } from "../components/landing/landingContent";
import { LogoMark } from "../components/shell/nav";

/**
 * Public landing page at "/" (rendered without the app shell). Every CTA goes to a real route:
 * /signup, /login, /overview (the app) and a real finding for the live demo. The static landing-only build
 * (LANDING_ONLY) has none of those routes, so its CTAs lead to the beta sign-up form in the final section instead.
 *
 * Layers, back to front: the fixed blue-black base (LandingBackground), the hero's optical emitter and blue beam,
 * small decorative observation accents in negative space, then content. The hero entrance waits for the opening intro to finish (`intro` state).
 */
export function LandingPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Underwatch: verify what your coding agent did";
    return () => {
      document.title = prev;
    };
  }, []);

  const [intro, setIntro] = useState(shouldPlayIntro);

  return (
    <>
    {intro && <IntroAnimation onDone={() => setIntro(false)} />}
    <div className="kw-landing relative h-full overflow-y-auto overflow-x-hidden text-text" data-testid="landing-page">
      <LandingBackground />
      <a href="#landing-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-3 focus:py-2">
        Skip to content
      </a>
      <LandingNav />
      <main id="landing-main" className="relative z-[1]">
        <Hero ready={!intro} />
        <ProductEvidencePreview />
        <ComparisonSection />
        <FeatureSections />
        <HowItWorks />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
    </>
  );
}

const wrap = "mx-auto w-full max-w-[1240px] px-4 sm:px-6";
const ctaPrimary = "kw-btn kw-btn-primary";
const ctaSecondary = "kw-btn kw-btn-secondary";

/** Fixed, non-interactive environment behind every section: a quiet blue-black base with soft vignetting. */
function LandingBackground() {
  return (
    <div aria-hidden="true" className="kw-bg pointer-events-none fixed inset-0 z-0">
      <div className="kw-bg-vignette" />
    </div>
  );
}

const NAV_LINKS = LANDING_ONLY
  ? [
      { href: "#features", label: "Product" },
      { href: "#how-it-works", label: "How it works" },
      { href: BETA_HREF, label: BETA_CTA },
    ]
  : [
      { href: "#features", label: "Product" },
      { href: "#how-it-works", label: "How it works" },
    ];

function LandingNav() {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const header = ref.current;
    const scroller = header?.closest(".kw-landing");
    if (!header || !scroller) return;
    const onScroll = () => {
      header.dataset.scrolled = scroller.scrollTop > 8 ? "true" : "false";
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header ref={ref} className="kw-nav sticky top-0 z-40 px-3 pt-3 sm:px-4">
      <div className="kw-nav-bar mx-auto flex h-14 max-w-[1240px] items-center justify-between gap-3 rounded-xl pl-3 pr-2 sm:pl-4">
        <Link to="/" className="flex items-center gap-2 rounded-sm text-[14px] font-semibold tracking-tight" aria-label="Underwatch home">
          <LogoMark size={22} />
          <span>Underwatch</span>
        </Link>
        <nav aria-label="Landing" className="hidden items-center gap-7 text-[13px] text-text-secondary md:flex">
          {NAV_LINKS.filter((l) => l.href !== BETA_HREF).map((l) => (
            <a key={l.href} href={l.href} className="transition-colors duration-150 hover:text-text">
              {l.label}
            </a>
          ))}
          {!LANDING_ONLY && <Link to="/overview" className="transition-colors duration-150 hover:text-text">Open the app</Link>}
        </nav>
        <div className="flex items-center gap-1.5">
          {LANDING_ONLY ? (
            <a href={BETA_HREF} className="kw-btn kw-btn-primary kw-btn-sm">
              {BETA_CTA}
            </a>
          ) : (
            <>
              <Link to="/login" className="hidden h-8 items-center rounded-md px-3 text-[13px] text-text-secondary hover:text-text sm:inline-flex">
                Log in
              </Link>
              <Link to="/signup" className="kw-btn kw-btn-primary kw-btn-sm">
                Sign up
              </Link>
            </>
          )}
          <button
            type="button"
            className="kw-menu-btn md:hidden"
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3.5 6.5h13M3.5 13.5h13" />}
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <nav id="landing-menu" aria-label="Landing menu" className="kw-nav-menu mx-auto mt-2 max-w-[1240px] rounded-xl p-2 md:hidden">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="block rounded-md px-3 py-2.5 text-[14px] text-text-secondary hover:bg-white/[0.04] hover:text-text">
              {l.label}
            </a>
          ))}
          {!LANDING_ONLY && (
            <>
              <Link to="/overview" className="block rounded-md px-3 py-2.5 text-[14px] text-text-secondary hover:bg-white/[0.04] hover:text-text">Open the app</Link>
              <Link to="/login" className="block rounded-md px-3 py-2.5 text-[14px] text-text-secondary hover:bg-white/[0.04] hover:text-text">Log in</Link>
            </>
          )}
        </nav>
      )}
    </header>
  );
}

/** Pointer-follow light for interactive surfaces: stores the pointer position as --mx / --my for the CSS highlight. */
function trackPointer(e: ReactPointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

function Shot({ shot, priority = false, className = "" }: { shot: LandingShot; priority?: boolean; className?: string }) {
  return (
    <figure className={`kw-shot ${className}`}>
      <div className="kw-shot-frame">
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
function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
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
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
      className={`transition-[opacity,transform] duration-500 ease-out ${shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"} ${className}`}
    >
      {children}
    </div>
  );
}

/** Minimal line-art optical emitter: an outlined lens housing with a lit aperture, drawn in the UI's stroke language. */
function OpticalEmitter({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 56" className={className} aria-hidden="true" focusable="false" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M24 4h32M30 4v6M50 4v6" stroke="#5F7395" strokeWidth="1.1" />
      <path d="M12 21h7M61 21h7" stroke="#3E5170" strokeWidth="1.1" />
      <circle cx="40" cy="21" r="17" stroke="#25334B" strokeWidth="1" />
      <rect x="27" y="10" width="26" height="20" rx="5" stroke="#9DBEFF" strokeOpacity="0.85" strokeWidth="1.3" />
      <path d="M33 16h14M33 21h14" stroke="#9DBEFF" strokeOpacity="0.35" strokeWidth="1" />
      <path d="M22 30h36l-4 6H26z" stroke="#9DBEFF" strokeOpacity="0.85" strokeWidth="1.3" />
      <ellipse cx="40" cy="38" rx="11" ry="2.6" stroke="#CFE0FF" strokeWidth="1.2" />
      <ellipse cx="40" cy="38" rx="5.5" ry="1.2" fill="#F2F7FF" />
    </svg>
  );
}

/** Designed light: a narrow core column and a wider feathered funnel (vector shapes, not simulated light). */
function HeroLight() {
  return (
    <div aria-hidden="true" className="kw-light pointer-events-none absolute inset-0">
      <svg className="kw-beam kw-beam-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="kw-beam-outer" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4169E1" stopOpacity="0.3" />
            <stop offset="0.45" stopColor="#3158C8" stopOpacity="0.09" />
            <stop offset="1" stopColor="#1B2F73" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="kw-beam-inner" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9DC2FF" stopOpacity="0.45" />
            <stop offset="0.5" stopColor="#75A9FF" stopOpacity="0.08" />
            <stop offset="1" stopColor="#75A9FF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="kw-beam-core" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
            <stop offset="0.4" stopColor="#DCE9FF" stopOpacity="0.1" />
            <stop offset="0.85" stopColor="#DCE9FF" stopOpacity="0" />
          </linearGradient>
          <filter id="kw-beam-blur-l" x="-20%" y="-5%" width="140%" height="110%">
            <feGaussianBlur stdDeviation="22 10" />
          </filter>
          <filter id="kw-beam-blur-m" x="-20%" y="-5%" width="140%" height="110%">
            <feGaussianBlur stdDeviation="9 6" />
          </filter>
          <filter id="kw-beam-blur-s" x="-50%" y="-5%" width="200%" height="110%">
            <feGaussianBlur stdDeviation="3 3" />
          </filter>
        </defs>
        <path d="M490 0C494 260 330 640 40 1000H960C670 640 506 260 510 0Z" fill="url(#kw-beam-outer)" filter="url(#kw-beam-blur-l)" />
        <path d="M496 0C498 280 420 650 300 1000H700C580 650 502 280 504 0Z" fill="url(#kw-beam-inner)" filter="url(#kw-beam-blur-m)" />
        <path d="M498.5 0C499.5 300 482 650 455 1000H545C518 650 500.5 300 501.5 0Z" fill="url(#kw-beam-core)" filter="url(#kw-beam-blur-s)" />
      </svg>
      <div className="kw-beam-pool" />
      <div className="kw-hero-mask" />
      <OpticalEmitter className="kw-emitter" />
    </div>
  );
}

const HERO_CARDS = [
  { n: "01", title: "Observe", body: "Independent evidence of what the agent actually did.", href: "#feature-observe" },
  { n: "02", title: "Compare", body: "What the agent said versus what actually happened.", href: "#feature-compare" },
  { n: "03", title: "Investigate", body: "Trace events, files, findings and relationships through evidence.", href: "#feature-investigate" },
  { n: "04", title: "Safeguard", body: "Turn incidents into reviewed protections and re-test them.", href: "#feature-safeguards" },
];

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function Hero({ ready }: { ready: boolean }) {
  return (
    <section aria-labelledby="landing-hero-title" className="kw-hero relative" data-ready={ready ? "true" : "false"}>
      <HeroLight />
      <div className={`${wrap} relative flex flex-col items-center pb-16 text-center sm:pb-20`}>
        <p className="kw-enter kw-eyebrow" style={delay(950)}>
          Underwatch <span aria-hidden="true" className="mx-1.5 text-[#3A4A66]">/</span> Independent agent observability
        </p>
        <h1 id="landing-hero-title" className="kw-enter kw-hero-title mt-5" style={delay(1050)}>
          <span className="block">Your AI agents work.</span> <span className="kw-hero-accent block">Under our watch.</span>
        </h1>
        <p className="kw-enter mt-6 max-w-[640px] text-[clamp(17px,1.6vw,21px)] font-medium leading-snug tracking-[-0.01em] text-text" style={delay(1180)}>
          Don't just trust what your coding agent says it did.
        </p>
        <p className="kw-enter mt-3 max-w-[560px] text-[15px] leading-relaxed text-text-secondary sm:text-[16px]" style={delay(1260)}>
          Independent observability and security for AI coding agents.
        </p>
        <section aria-label="Get started" className="kw-enter mt-8 flex flex-col items-center" style={delay(1360)}>
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
              <p className="mt-3 text-[12px] text-text-tertiary">For individuals and companies. We will email you as soon as the beta opens.</p>
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
                <Link to={FIXTURE_DEMO_HREF} className="underline decoration-[#25334B] underline-offset-2 hover:text-text">
                  fx-04 example finding
                </Link>
                .
              </p>
            </>
          )}
        </section>
        <ul className="mt-14 grid w-full grid-cols-1 gap-3 text-left sm:mt-16 sm:grid-cols-2 lg:grid-cols-4" aria-label="Capabilities">
          {HERO_CARDS.map((c, i) => (
            <li key={c.n} className="kw-enter flex" style={delay(1500 + i * 90)}>
              <a href={c.href} onPointerMove={trackPointer} className="kw-card kw-stage-card flex w-full flex-col">
                <span className="flex items-center justify-between">
                  <span className="kw-pill">{c.n}</span>
                  <span aria-hidden="true" className="kw-card-arrow">→</span>
                </span>{" "}
                <span className="mt-5 text-[17px] font-semibold tracking-[-0.01em] text-text">{c.title}</span>{" "}
                <span className="kw-card-body mt-1.5 text-[13.5px] leading-relaxed">{c.body}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SectionHeading({ id, eyebrow, title, children, center = false }: { id: string; eyebrow?: string; title: string; children?: ReactNode; center?: boolean }) {
  return (
    <div className={`kw-readable ${center ? "mx-auto max-w-[720px] text-center" : "max-w-[620px]"}`}>
      {eyebrow && <p className="kw-eyebrow">{eyebrow}</p>}
      <h2 id={id} className="kw-h2 mt-3">
        {title}
      </h2>
      {children && <p className="mt-4 text-[15px] leading-relaxed text-text-secondary sm:text-[16px]">{children}</p>}
    </div>
  );
}

function ProductEvidencePreview() {
  return (
    <section aria-labelledby="preview-title" className="kw-section relative">
      <div className={`${wrap} relative pb-20 pt-6 sm:pb-28`}>
        <EyeFlowerCluster variant="a" className="kw-accent kw-accent-xl kw-accent-preview-l" />
        <EyeFlowerCluster variant="b" className="kw-accent kw-accent-xl kw-accent-preview-r" />
        <Reveal>
          <SectionHeading id="preview-title" eyebrow="The product" title="See what actually happened." center>
            Your agent's report is only one side of the story. Underwatch compares it with independently recorded evidence.
          </SectionHeading>
        </Reveal>
        <Reveal delay={80}>
          <div className="kw-shot-stage mt-10 sm:mt-12">
            <Shot shot={HERO_SHOT} priority />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Why Underwatch: agent-reported narrative vs independent evidence, around the orbital evidence network. */
function ComparisonSection() {
  return (
    <section id="why" aria-labelledby="problem-title" className="kw-section relative scroll-mt-20">
      <div className={`${wrap} py-20 sm:py-28`}>
        <Reveal>
          <SectionHeading id="problem-title" eyebrow="Why Underwatch" title="What your agent reports isn't the whole story." center>
            Underwatch shows what actually happened, and what needs your attention.
          </SectionHeading>
        </Reveal>
        <OrbitalEvidence />
      </div>
    </section>
  );
}

const OBSERVERS = [
  { name: "Files", detail: "What the agent read and changed" },
  { name: "Commands", detail: "What actually ran" },
  { name: "Network", detail: "Where requests went" },
];
const GRAPH_NODES = ["Findings", "Rules", "Agent actions", "Recorded activity", "Files", "Safeguards"];
const SAFEGUARD_FLOW = ["Finding", "Proposed safeguard", "Your review (diff)", "Re-test", "Recorded result"];
const SAFEGUARD_KINDS = ["Agent instructions", "Permission rules", "System-level blocks"];

function FeatureExtra({ id }: { id: string }) {
  if (id === "observe") {
    return (
      <ul className="mt-6 grid gap-2.5">
        {OBSERVERS.map((o) => (
          <li key={o.name} className="kw-module flex items-start gap-3 rounded-lg px-3.5 py-3">
            <span aria-hidden="true" className="kw-module-dot mt-[7px]" />
            <span>
              <span className="block font-mono text-[12px] text-[#9DBEFF]">{o.name}</span>
              <span className="block text-[14px] text-text-secondary">{o.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (id === "compare") {
    return (
      <div className="kw-split mt-6 grid grid-cols-2 overflow-hidden rounded-lg">
        <div className="p-3.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[#D3A6E6]">Agent says</p>
          <p className="mt-1 text-[13.5px] text-text-secondary">The agent's own account of its work</p>
        </div>
        <div className="border-l border-[#25334B] p-3.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[#67B7E3]">Underwatch saw</p>
          <p className="mt-1 text-[13.5px] text-text-secondary">An independent record of what happened</p>
        </div>
      </div>
    );
  }
  if (id === "investigate") {
    return (
      <div className="mt-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-tertiary">In the evidence graph</p>
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {GRAPH_NODES.map((n) => (
            <li key={n} className="kw-chip">{n}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (id === "safeguards") {
    return (
      <div className="mt-6 space-y-4">
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[12.5px]" aria-label="Safeguard workflow">
          {SAFEGUARD_FLOW.map((s, i) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className="kw-chip">{s}</span>
              {i < SAFEGUARD_FLOW.length - 1 && <span aria-hidden="true" className="text-[#4A5A78]">→</span>}
            </li>
          ))}
        </ol>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-tertiary">A proposed safeguard can be</p>
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {SAFEGUARD_KINDS.map((k) => (
              <li key={k} className="kw-chip font-mono text-[11.5px]">{k}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  return null;
}

const FEATURE_CHARACTERS: Record<string, ComponentType<{ className?: string }>> = {
  observe: ObserverCharacter,
  compare: CompareCharacter,
  investigate: InvestigateCharacter,
  safeguards: SafeguardCharacter,
};

/** Small supporting scene under each feature's copy (observing, comparing, investigating, safeguarding). */
function FeatureCharacter({ id }: { id: string }) {
  const Character = FEATURE_CHARACTERS[id];
  if (!Character) return null;
  return (
    <div aria-hidden="true" className="kw-character pointer-events-none mt-8 hidden sm:block">
      <Character className="h-auto w-[148px]" />
    </div>
  );
}

function FeatureSections() {
  return (
    <div id="features" className="scroll-mt-20">
      {FEATURES.map((f, i) => (
        <section key={f.id} id={`feature-${f.id}`} aria-labelledby={`feature-${f.id}-title`} className="kw-section relative scroll-mt-20">
          <div className={`${wrap} grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16`}>
            <Reveal className={i % 2 === 1 ? "lg:order-2" : ""}>
              <div className="kw-readable">
                <p className="flex items-center gap-2.5">
                  <span className="kw-pill">0{i + 1}</span>
                  <span className="text-[13px] font-medium text-[#9DBEFF]">{f.eyebrow}</span>
                </p>
                <h2 id={`feature-${f.id}-title`} className="kw-h2 mt-4">
                  {f.title}
                </h2>
                <p className="mt-4 text-[15px] leading-relaxed text-text-secondary sm:text-[16px]">{f.body}</p>
              </div>
              {f.id !== "observe" && (
                <ul className="mt-6 space-y-2.5 text-[14px] text-[#C9D2E3]">
                  {f.points.map((p) => (
                    <li key={p} className="flex gap-2.5">
                      <span aria-hidden="true" className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${p.toLowerCase().startsWith("safeguards tested") ? "bg-[#47C9A5]" : "bg-[#4F7BEA]"}`} />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              )}
              <FeatureExtra id={f.id} />
              <FeatureCharacter id={f.id} />
            </Reveal>
            <Reveal delay={100} className={`min-w-0 ${i % 2 === 1 ? "lg:order-1" : ""}`}>
              <Shot shot={f.shot} />
            </Reveal>
          </div>
        </section>
      ))}
    </div>
  );
}

const STEP_ICONS = [
  <path key="run" d="M4 6l4 4-4 4M10 14h6" />,
  <path key="rec" d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5zM10 12a2 2 0 100-4 2 2 0 000 4z" />,
  <path key="cmp" d="M7 3v14M13 3v14M3 7h4M13 7h4M3 13h4M13 13h4" />,
  <path key="safe" d="M10 2.5l6 2.5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5l6-2.5zM7.3 10l1.9 1.9 3.6-3.8" />,
];

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="kw-section relative scroll-mt-20">
      <div className={`${wrap} relative py-20 sm:py-28`}>
        <ChecklistCharacter className="kw-accent kw-accent-lg kw-accent-how" />
        <Reveal>
          <SectionHeading id="how-title" eyebrow="How it works" title="From agent execution to verified safeguards." />
        </Reveal>
        <ol className="kw-steps mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.n} className="kw-step relative flex">
              <Reveal delay={i * 90} className="flex w-full">
                <div tabIndex={0} onPointerMove={trackPointer} className="kw-card kw-step-card flex w-full flex-col">
                  <span className="flex items-center justify-between">
                    <span className="font-mono text-[28px] font-medium leading-none tracking-[-0.02em] text-[#3E5170] kw-step-num">{s.n}</span>
                    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="kw-step-icon">
                      {STEP_ICONS[i]}
                    </svg>
                  </span>
                  <h3 className="mt-6 text-[16px] font-semibold text-text">{s.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">{s.body}</p>
                </div>
              </Reveal>
              {i < STEPS.length - 1 && <span aria-hidden="true" className="kw-step-link" />}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section id={LANDING_ONLY ? "beta" : undefined} aria-labelledby="final-cta-title" className="kw-garden relative scroll-mt-20 overflow-hidden">
      <div aria-hidden="true" className="kw-garden-side kw-garden-left">
        <EyeGarden side="left" />
      </div>
      <div aria-hidden="true" className="kw-garden-side kw-garden-right">
        <EyeGarden side="right" />
      </div>
      <div aria-hidden="true" className="kw-cta-light pointer-events-none absolute inset-0" />
      <div className={`${wrap} relative py-24 sm:py-36`}>
        <div className="kw-readable mx-auto max-w-[640px] text-center">
          <h2 id="final-cta-title" className="kw-h2">
            Your AI agents work. <span className="kw-hero-accent">Under our watch.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-[520px] text-[15px] leading-relaxed text-text-secondary sm:text-[16px]">
            {LANDING_ONLY
              ? "Get early access to independent observability and security for AI coding agents."
              : "Don't just trust what your coding agent says it did."}
          </p>
          {LANDING_ONLY ? (
            <div className="kw-cta-card mx-auto mt-8 max-w-[560px] rounded-2xl px-4 pb-6 pt-1 sm:px-6">
              <BetaSignupForm />
            </div>
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
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="kw-footer relative z-[1]">
      <div className={`${wrap} flex flex-col gap-5 py-10 text-[12px] text-text-tertiary sm:flex-row sm:items-center sm:justify-between`}>
        <div>
          <div className="flex items-center gap-2 text-text-secondary">
            <LogoMark size={18} />
            <span className="font-medium">Underwatch</span>
          </div>
          <p className="mt-2">Independent observability and security for AI coding agents.</p>
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
