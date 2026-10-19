import { z } from "zod";
import { Timestamp } from "./entities";

// ---------------------------------------------------------------------------------------------------------------
// Local accounts (POST /api/accounts/signup, /login, /logout; GET /api/accounts/me).
//
// Accounts live in the local SQLite database. Signup is allowed only with the local API token (Bearer) or
// setup_code equal to it, so creating access still requires local access to data/auth-token. A session token is a
// Bearer credential accepted by the API guard alongside the API token. Password hashes are never returned.
// ---------------------------------------------------------------------------------------------------------------

export const ACCOUNT_PASSWORD_MIN_LENGTH = 10;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 1024;

export const AccountId = z.string().regex(/^acct_[A-Za-z0-9_-]+$/);
export type AccountId = z.infer<typeof AccountId>;

export const AccountUser = z.object({
  id: AccountId,
  name: z.string(),
  email: z.string(),
  created_at: Timestamp,
});
export type AccountUser = z.infer<typeof AccountUser>;

export const AccountSession = z.object({
  /** Bearer credential (shown once, at signup/login). Only its sha256 is stored server-side. */
  token: z.string(),
  expires_at: Timestamp,
});
export type AccountSession = z.infer<typeof AccountSession>;

export const AccountSignupBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(ACCOUNT_PASSWORD_MIN_LENGTH).max(ACCOUNT_PASSWORD_MAX_LENGTH),
  /** The local API token (data/auth-token). Required unless the request already carries it as Bearer. */
  setup_code: z.string().max(256).optional(),
});
export type AccountSignupBody = z.infer<typeof AccountSignupBody>;

export const AccountLoginBody = z.object({
  email: z.string().max(254),
  password: z.string().max(ACCOUNT_PASSWORD_MAX_LENGTH),
});
export type AccountLoginBody = z.infer<typeof AccountLoginBody>;

/** 201 from signup, 200 from login. */
export const AccountAuthResponse = z.object({ user: AccountUser, session: AccountSession });
export type AccountAuthResponse = z.infer<typeof AccountAuthResponse>;

export const AccountMeResponse = z.object({ user: AccountUser });
export type AccountMeResponse = z.infer<typeof AccountMeResponse>;
