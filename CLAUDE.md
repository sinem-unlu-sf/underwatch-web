# Underwatch web (live site)

## Deploy: this folder is what underwatchai.com serves

- Live site: https://underwatchai.com, Vercel project `underwatch` (team `sinems-projects-b53d5525`, CLI account `sinemunlu-3457`, logged in on this MacBook).
- Source: this folder, `~/Desktop/academics/underwatch/underwatch-web`. GitHub `sinem-unlu-sf/underwatch-web`, working branch `landing-redesign-waitlist`.
- Vercel is NOT connected to GitHub. Pushing does not deploy. Deploy by hand from this folder's root:
  `vercel deploy --prod --yes`
- Vercel settings: root `.`, build `pnpm --filter @kw/web run build:landing`, output `apps/web/dist`, install `pnpm install --frozen-lockfile`.
- Production deploys need the user's go-ahead each time (Claude Code auto mode blocks them; the user can run the command with `! ...`).
- Before deploying: `npx tsc --noEmit -p apps/web`, `npx vitest run src/App.routing.test.tsx` (in `apps/web`), and the landing build above.
- After deploying: fetch https://underwatchai.com and its JS bundle and grep for the change. Roll back with `vercel rollback`.
- The other copy, `~/Desktop/academics/hackathons/81agents` (GitHub `thehephaistos/underwatch`), has an older landing page. Never link or deploy it to this Vercel project.

## Landing page rules

- Don't reveal how Underwatch works: no tech stack or method on the landing page (Neo4j, ai&, Tetragon, Cilium, eBPF, egress proxy, git observer, kernel tracing, "reported vs observed" internals). Describe outcomes in plain words.
- No product screenshots. Use the illustrated scenes (`apps/web/src/components/landing/FeatureScenes.tsx`), the evidence radar (`EvidenceRadar.tsx`) and the characters (`LandingCharacters.tsx`).
- Landing copy lives in `apps/web/src/pages/LandingPage.tsx`, `apps/web/src/components/landing/landingContent.ts` and `OrbitalEvidence.tsx`.
- `apps/web/src/components/landing/ParticleTerrain.tsx` is untracked work in progress; leave it alone unless asked.
