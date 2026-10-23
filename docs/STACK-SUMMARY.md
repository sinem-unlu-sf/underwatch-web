# Underwatch: stack and how it works (brief)

Underwatch runs an AI coding agent (Claude Code) in a disposable container, observes it from outside, compares what the agent *says* it did with what *actually* happened, and turns gaps into safeguards that are re-tested. Details: `README.md` and `docs/ARCHITECTURE.md`.

## Stack

| Layer | Technology |
|---|---|
| Monorepo | TypeScript, pnpm workspaces, Node ≥ 22.13 |
| Web app + landing page | React 19, Vite 8, Tailwind CSS v4, React Router 7, TanStack Query (`apps/web`) |
| API server | Fastify 5 + `node:sqlite` (system of record), Zod contracts (`apps/server`, `packages/schema`) |
| Agent sandbox | Docker: agent image, default-deny egress proxy, credential broker, network guard (`docker/`) |
| Kernel observation | Cilium Tetragon (eBPF): process exec, file open, network connect (`packages/observer-tetragon`) |
| Evidence graph | Neo4j, a projection of SQLite, rebuilt from it if needed (`packages/graph`) |
| AI explanations | ai& Inference for Ask Witness, behind a fail-closed redaction step (`packages/inference`, `packages/redaction`) |
| Hosting | Vercel: static landing build (`vercel.json`) + one function `api/beta-signup.ts` |
| Beta list storage | Upstash Redis (Vercel Marketplace), records encrypted with AES-256-GCM |
| Tests | Vitest + Testing Library (`pnpm test`), `tsc` typecheck |

## How a supervised run works

1. **Run.** The supervisor starts Claude Code headless in a fresh container with a per-run workspace and managed settings. Its only way out is the allowlisting proxy.
2. **Record independently.** Two lanes are collected:
   - *Reported:* the agent's own stream-json output and tool-call hooks.
   - *Observed:* Tetragon kernel events, the proxy log, and a host-side git diff of the workspace. The agent cannot edit these.
3. **Store raw first.** Raw bytes are written to a content-addressed store (SHA-256), with a manifest, before anything is parsed. Unparseable data is kept and counted as a coverage gap rather than dropped.
4. **Normalize.** Every record becomes an event with a deterministic id that is unique per run, basis (reported/observed), source and native key. Importing is idempotent, and a conflicting duplicate is flagged, never overwritten.
5. **Analyze once, after the run closes.** A pure analysis pass (`packages/analysis`) matches reported actions to observed events, applies the policy rules (e.g. protected paths such as `.env`), and produces **findings** with severity, confidence and the evidence ids behind them. Anything that wasn't observed is shown as *unknown*, never as safe.
6. **Project to Neo4j.** Findings, events, files, processes, rules and safeguards are merged into the graph for path queries ("finding → rule → agent action → kernel event").
7. **Ask Witness.** Questions about a finding are answered by ai& from a redacted bundle of Underwatch records. Each citation is checked against the records sent, and the claim labels are set by Underwatch, not by the model.
8. **Safeguard and verify.** A finding can become a proposed safeguard (a `CLAUDE.md` instruction, a Claude Code permission rule, or a Tetragon kernel deny), reviewed as a diff. A fresh agent run then re-tests the same scenario. "Passed" requires independent (observed) evidence; agent-reported data alone can never pass a safeguard.

## Landing page (`apps/web/src/pages/LandingPage.tsx`, landing-only build)

- **Intro (`IntroAnimation.tsx`).** One `requestAnimationFrame` timeline draws SVG paths directly, with no React renders per frame: seven circles draw in and blink, spiral into a Seed of Life, then fold into an eye. That fold is two-circle vesica geometry: the outer arcs become the brows and the centre circle narrows into the pupil. It plays once per session and is skipped under reduced motion.
- **Hero.** A line-art optical emitter and a designed SVG light funnel built from layered gradients and blur, revealed after the intro finishes.
- **Orbital comparison (`OrbitalEvidence.tsx`).** Three independent animation systems in one rAF loop: woven ellipse and circle groups moving against each other, a breathing ring with a travelling gradient, and evidence dots on their own tilted elliptical orbits. Selecting a card eases emphasis onto the related dots and paths. It pauses off-screen.
- **Decoration.** Eye-flowers, the eye garden and small character scenes are pure SVG with CSS keyframes (blink, sway, fade). All of it is `aria-hidden` and static under reduced motion.
- **Beta sign-up.** The form posts to `/api/beta-signup`. The function validates the input (required names, a honeypot field), derives two keys from the `BETA_DATA_KEY` secret (HKDF), stores the record encrypted (AES-256-GCM) under an HMAC of the email, and refuses to store anything if the key is missing. `scripts/beta-signups-export.ts` decrypts the list locally to CSV.

## Commands

```sh
pnpm install
pnpm dev                                              # API (4600) + web app (4601)
VITE_LANDING_ONLY=1 pnpm --filter @kw/web exec vite   # landing page only
pnpm test && pnpm typecheck
pnpm --filter @kw/web run build:landing               # what Vercel builds
```
