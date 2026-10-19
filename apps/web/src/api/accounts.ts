/**
 * Local accounts (POST /api/accounts/signup | login | logout, GET /api/accounts/me).
 * Accounts live in the local server's SQLite database; a session token is a Bearer token accepted by the same auth
 * middleware as the local API token, so it is stored exactly where that token is stored today (localStorage "kw.token").
 * Signup is only accepted with local access: the stored local API token (sent automatically as Bearer) or a setup
 * code equal to data/auth-token. The web package does not depend on zod, so responses are checked structurally here.
 */
import { requestJson, requestNoContent } from "./client";

export const accountPaths = {
  signup: "/api/accounts/signup",
  login: "/api/accounts/login",
  logout: "/api/accounts/logout",
  me: "/api/accounts/me",
} as const;

export interface AccountUser {
  id: string;
  name: string;
  email: string;
  created_at: string;
}
export interface AccountSession {
  token: string;
  expires_at: string;
}
export interface AccountAuthResponse {
  user: AccountUser;
  session: AccountSession;
}
export interface AccountMeResponse {
  user: AccountUser;
}

type Parsed<T> = { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };

const fail = (path: string, message: string): Parsed<never> => ({ success: false, error: { issues: [{ path: [path], message }] } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkUser(v: unknown): string | null {
  if (!isObj(v)) return "user: expected object";
  for (const k of ["id", "name", "email", "created_at"] as const) if (typeof v[k] !== "string") return `user.${k}: expected string`;
  return null;
}

const AuthResponseSchema = {
  safeParse(data: unknown): Parsed<AccountAuthResponse> {
    if (!isObj(data)) return fail("(root)", "expected object");
    const u = checkUser(data.user);
    if (u) return fail("user", u);
    const s = data.session;
    if (!isObj(s) || typeof s.token !== "string" || s.token.length === 0 || typeof s.expires_at !== "string") return fail("session", "expected {token, expires_at}");
    return { success: true, data: data as unknown as AccountAuthResponse };
  },
};

const MeResponseSchema = {
  safeParse(data: unknown): Parsed<AccountMeResponse> {
    if (!isObj(data)) return fail("(root)", "expected object");
    const u = checkUser(data.user);
    if (u) return fail("user", u);
    return { success: true, data: data as unknown as AccountMeResponse };
  },
};

export interface SignupInput {
  name: string;
  email: string;
  password: string;
  /** Only when the browser has no usable local API token. Sent in the body and as the Bearer credential. */
  setup_code?: string;
}

const jsonPost = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export const accountsApi = {
  signup: (input: SignupInput) => {
    const code = input.setup_code?.trim();
    const body = { name: input.name, email: input.email, password: input.password, ...(code ? { setup_code: code } : {}) };
    return requestJson(accountPaths.signup, AuthResponseSchema, jsonPost(body, code ? { Authorization: `Bearer ${code}` } : {}));
  },
  login: (email: string, password: string) => requestJson(accountPaths.login, AuthResponseSchema, jsonPost({ email, password })),
  logout: () => requestNoContent(accountPaths.logout, { method: "POST" }),
  me: () => requestJson(accountPaths.me, MeResponseSchema),
};

export const accountQueryKeys = { me: ["accounts", "me"] as const };

/** Client-side password guidance only; the server enforces its own rules. */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length === 0) return { score: 0, label: "" };
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (pw.length < 8) return { score: 1, label: "Too short (8+ characters)" };
  if (pw.length >= 14 || (pw.length >= 10 && classes >= 3)) return { score: 3, label: "Strong" };
  if (classes >= 2) return { score: 2, label: "Fair" };
  return { score: 1, label: "Weak: mix letters, numbers or symbols" };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
