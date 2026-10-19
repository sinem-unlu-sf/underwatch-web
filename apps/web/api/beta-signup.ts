/**
 * Beta sign-up endpoint for the static landing page (Vercel Function: POST /api/beta-signup).
 *
 * Storage: Upstash Redis over its REST API (add "Upstash for Redis" from the Vercel Marketplace; it sets
 * KV_REST_API_URL / KV_REST_API_TOKEN). Each sign-up is one key, `beta:signup:<email>`, written with NX so a repeat
 * sign-up keeps the original record, plus a `beta:signups` sorted set (score = sign-up time) for exporting the list.
 *
 * Confirmation: when RESEND_API_KEY and BETA_FROM_EMAIL are set, a new sign-up gets a confirmation email right
 * away. Without them the sign-up is still stored and the page still confirms it on screen.
 *
 * Kept in one file (no relative imports) because Vercel runs it as a native ESM module. The Vite dev/preview server
 * serves the same handler locally with a file-backed store (see vite.config.ts).
 */

export type SignupKind = "individual" | "company";

export type BetaSignup = {
  email: string;
  kind: SignupKind;
  name: string | null;
  company: string | null;
  createdAt: string;
};

/** Saves a sign-up; returns false when that email already signed up (the stored record is left as it was). */
export type SignupStore = { save: (signup: BetaSignup) => Promise<boolean> };

export type Mailer = (signup: BetaSignup) => Promise<void>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Parsed = { ok: true; signup: BetaSignup } | { ok: false; error: string; bot?: boolean };

export function parseSignup(body: unknown, now = new Date()): Parsed {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Invalid request." };
  const b = body as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  // Honeypot: a hidden field people never fill in.
  if (str(b.website, 200)) return { ok: false, error: "Invalid request.", bot: true };
  const email = str(b.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  const kind: SignupKind = b.kind === "company" ? "company" : "individual";
  const company = str(b.company, 120);
  if (kind === "company" && !company) return { ok: false, error: "Enter your company name." };
  return {
    ok: true,
    signup: { email, kind, name: str(b.name, 120) || null, company: kind === "company" ? company : null, createdAt: now.toISOString() },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleBetaSignup(request: Request, store: SignupStore | null, mailer: Mailer | null): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid request." });
  }
  const parsed = parseSignup(body);
  // Bots get a normal-looking success so they do not retry; nothing is stored.
  if (!parsed.ok) return parsed.bot ? json(200, { status: "created", emailed: false }) : json(400, { error: parsed.error });
  if (!store) {
    console.error("beta-signup: no store configured (set KV_REST_API_URL and KV_REST_API_TOKEN)");
    return json(503, { error: "Sign-ups are not open yet. Please try again later." });
  }
  let created: boolean;
  try {
    created = await store.save(parsed.signup);
  } catch (err) {
    console.error("beta-signup: store failed", err);
    return json(502, { error: "Could not save your sign-up. Please try again." });
  }
  let emailed = false;
  if (created && mailer) {
    // The sign-up is already saved; a failed email must not turn it into an error for the visitor.
    emailed = await mailer(parsed.signup).then(
      () => true,
      (err) => (console.error("beta-signup: confirmation email failed", err), false),
    );
  }
  return json(200, { status: created ? "created" : "exists", emailed });
}

/** Upstash Redis REST store (env names from the Vercel Marketplace integration, or Upstash's own). */
export function upstashStoreFromEnv(env = process.env): SignupStore | null {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    async save(signup) {
      const res = await fetch(`${url.replace(/\/$/, "")}/multi-exec`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify([
          ["SET", `beta:signup:${signup.email}`, JSON.stringify(signup), "NX"],
          ["ZADD", "beta:signups", "NX", String(Date.parse(signup.createdAt)), signup.email],
        ]),
      });
      if (!res.ok) throw new Error(`Upstash responded ${res.status}`);
      const results = (await res.json()) as { result?: unknown; error?: string }[];
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(`Upstash error: ${failed.error}`);
      return results[0]?.result === "OK";
    },
  };
}

/** Resend confirmation email; null when it is not configured. */
export function resendMailerFromEnv(env = process.env): Mailer | null {
  const key = env.RESEND_API_KEY;
  const from = env.BETA_FROM_EMAIL;
  if (!key || !from) return null;
  return async (signup) => {
    const greeting = signup.name ? `Hi ${signup.name},` : "Hi,";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [signup.email],
        subject: "You're on the Underwatch beta list",
        text: [
          greeting,
          "",
          `Thanks for signing up for the Underwatch beta${signup.company ? ` for ${signup.company}` : ""}. You're on the list.`,
          "",
          "We'll email this address when the beta opens, with everything you need to get started.",
          "",
          "If you didn't sign up, ignore this email and you won't hear from us again.",
          "",
          "The Underwatch team",
        ].join("\n"),
      }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
  };
}

export function POST(request: Request): Promise<Response> {
  return handleBetaSignup(request, upstashStoreFromEnv(), resendMailerFromEnv());
}
