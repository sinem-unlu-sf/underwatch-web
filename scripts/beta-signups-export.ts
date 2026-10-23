/**
 * Exports the beta sign-up list as CSV on stdout, decrypting each record locally (Node >= 22.18 runs this .ts directly).
 *
 * Needs KV_REST_API_URL and KV_REST_API_TOKEN (copy them from the Upstash console: they are stored as sensitive on
 * Vercel, so `vercel env pull` cannot return them) and BETA_DATA_KEY, in a local env file that is never committed:
 *   node --env-file=.env.beta scripts/beta-signups-export.ts > beta-signups.csv
 *
 * The output contains personal data: keep it off shared drives and delete it when you are done.
 */
import { openSignup, SIGNUP_INDEX, SIGNUP_KEY, signupKeys } from "../api/beta-signup.ts";

const url = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)?.replace(/\/$/, "");
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const secret = process.env.BETA_DATA_KEY;
if (!url || !token || !secret) {
  console.error("Set KV_REST_API_URL, KV_REST_API_TOKEN and BETA_DATA_KEY (see the header of this file).");
  process.exit(1);
}

const redis = async (command: string[]) => {
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(command) });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || body.error) throw new Error(`Upstash: ${body.error ?? res.status}`);
  return body.result;
};

const keys = await signupKeys(secret);
const ids = (await redis(["ZRANGE", SIGNUP_INDEX, "0", "-1"])) as string[];
const csv = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
console.log("created_at,kind,first_name,last_name,email,company");
for (const id of ids) {
  const raw = (await redis(["GET", `${SIGNUP_KEY}:${id}`])) as string | null;
  if (!raw) continue;
  const s = await openSignup(keys, JSON.parse(raw), id);
  console.log([s.createdAt, s.kind, s.firstName, s.lastName, s.email, s.company].map(csv).join(","));
}
