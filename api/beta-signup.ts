/**
 * Beta sign-up endpoint for the static landing page (Vercel Function: POST /api/beta-signup).
 *
 * Storage: Upstash Redis over its REST API (add "Upstash for Redis" from the Vercel Marketplace; it sets
 * KV_REST_API_URL / KV_REST_API_TOKEN). Personal data never reaches Redis in the clear: each record is encrypted with
 * AES-256-GCM and keyed by an HMAC of the email, both derived (HKDF) from the BETA_DATA_KEY secret (32 random bytes,
 * base64). The key is `underwatch:beta:signup:<hmac>` (namespaced so a shared database is safe), written with NX so
 * a repeat sign-up keeps the original record, plus an `underwatch:beta:signups` sorted set (score = sign-up time). Without BETA_DATA_KEY nothing is stored.
 * Export (decrypts locally): `node scripts/beta-signups-export.ts` with the same three env vars.
 *
 * Confirmation: when RESEND_API_KEY and BETA_FROM_EMAIL are set, a new sign-up gets a confirmation email right
 * away. Without them the sign-up is still stored and the page still confirms it on screen.
 *
 * Kept in one file (no relative imports) because Vercel runs it as a native ESM module. The Vite dev/preview server
 * serves the same handler locally with a file-backed store (see apps/web/vite.config.ts). It lives at the repo root
 * because Vercel builds this repo from its root (vercel.json) and only finds functions in <root>/api.
 */

/** process.env without needing @types/node: Vercel compiles this file from the repo root, which has no Node types. */
const processEnv: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export type SignupKind = "individual" | "company";

/** Individuals: first name, last name, email. Companies: company name, work email, and the contact person's name. */
export type BetaSignup = {
  kind: SignupKind;
  firstName: string;
  lastName: string;
  email: string;
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
  const firstName = str(b.firstName, 80);
  const lastName = str(b.lastName, 80);
  if (!firstName || !lastName) return { ok: false, error: "Enter your first and last name." };
  const company = str(b.company, 120);
  if (kind === "company" && !company) return { ok: false, error: "Enter your company name." };
  return {
    ok: true,
    signup: { kind, firstName, lastName, email, company: kind === "company" ? company : null, createdAt: now.toISOString() },
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
    console.error("beta-signup: no store configured (set KV_REST_API_URL, KV_REST_API_TOKEN and BETA_DATA_KEY)");
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

/** Redis key names, namespaced so the database can be shared with other projects. */
export const SIGNUP_KEY = "underwatch:beta:signup";
export const SIGNUP_INDEX = "underwatch:beta:signups";

const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export type SignupKeys = { aes: CryptoKey; index: CryptoKey };

/** Derives the record-encryption key and the email-index key from BETA_DATA_KEY (base64, 32 bytes). */
export async function signupKeys(secret: string): Promise<SignupKeys> {
  const raw = unb64(secret.trim());
  if (raw.length < 32) throw new Error("BETA_DATA_KEY must be at least 32 random bytes, base64-encoded");
  const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  type Usages = Parameters<typeof crypto.subtle.deriveKey>[4];
  const derive = (info: string, alg: { name: string; length: number; hash?: string }, usages: Usages) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) }, master, alg, false, usages);
  return {
    aes: await derive("underwatch-beta-signup-record-v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    index: await derive("underwatch-beta-signup-index-v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
  };
}

/** Stable, non-reversible id for an email (dedupe without storing the address in a key). */
export async function emailId(keys: SignupKeys, email: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", keys.index, enc.encode(email));
  return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, "0")).join("");
}

type SealedSignup = { v: 1; iv: string; ct: string; createdAt: string };

export async function sealSignup(keys: SignupKeys, signup: BetaSignup, id: string): Promise<SealedSignup> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(id) }, keys.aes, enc.encode(JSON.stringify(signup)));
  return { v: 1, iv: b64(iv), ct: b64(ct), createdAt: signup.createdAt };
}

export async function openSignup(keys: SignupKeys, sealed: SealedSignup, id: string): Promise<BetaSignup> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv), additionalData: enc.encode(id) }, keys.aes, unb64(sealed.ct));
  return JSON.parse(new TextDecoder().decode(pt)) as BetaSignup;
}

/** Upstash Redis REST store (env names from the Vercel Marketplace integration, or Upstash's own); null unless fully configured. */
export function upstashStoreFromEnv(env = processEnv): SignupStore | null {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  const secret = env.BETA_DATA_KEY;
  if (!url || !token) return null;
  if (!secret) {
    console.error("beta-signup: BETA_DATA_KEY is not set; refusing to store personal data unencrypted");
    return null;
  }
  let keys: Promise<SignupKeys> | null = null;
  return {
    async save(signup) {
      keys ??= signupKeys(secret);
      const k = await keys;
      const id = await emailId(k, signup.email);
      const sealed = await sealSignup(k, signup, id);
      const res = await fetch(`${url.replace(/\/$/, "")}/multi-exec`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify([
          ["SET", `${SIGNUP_KEY}:${id}`, JSON.stringify(sealed), "NX"],
          ["ZADD", SIGNUP_INDEX, "NX", String(Date.parse(signup.createdAt)), id],
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
export function resendMailerFromEnv(env = processEnv): Mailer | null {
  const key = env.RESEND_API_KEY;
  const from = env.BETA_FROM_EMAIL;
  if (!key || !from) return null;
  return async (signup) => {
    const greeting = `Hi ${signup.firstName},`;
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
