/// <reference types="vitest/config" />
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";
import { handleBetaSignup, resendMailerFromEnv, upstashStoreFromEnv, type BetaSignup, type SignupStore } from "./api/beta-signup";

const LOCAL_SIGNUPS_FILE = fileURLToPath(new URL("./.beta-signups.local.json", import.meta.url));

/** Local stand-in for Upstash: sign-ups go to a gitignored JSON file next to this config. */
const fileStore: SignupStore = {
  async save(signup) {
    const all: BetaSignup[] = existsSync(LOCAL_SIGNUPS_FILE) ? JSON.parse(readFileSync(LOCAL_SIGNUPS_FILE, "utf8")) : [];
    if (all.some((s) => s.email === signup.email)) return false;
    all.push(signup);
    writeFileSync(LOCAL_SIGNUPS_FILE, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`[beta-signup] saved ${signup.email} to ${LOCAL_SIGNUPS_FILE}`);
    return true;
  },
};

/**
 * Serves api/beta-signup.ts at /api/beta-signup under `vite` and `vite preview`, as Vercel does in production. Uses
 * Upstash and Resend when their env vars are set, otherwise the local file and no confirmation email.
 */
function betaSignupApi(): Plugin {
  const middleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
    if (req.url?.split("?")[0] !== "/api/beta-signup") return next();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const response = await handleBetaSignup(request, upstashStoreFromEnv() ?? fileStore, resendMailerFromEnv());
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await response.text());
    });
  };
  return {
    name: "beta-signup-api",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), betaSignupApi()],
  server: {
    host: "127.0.0.1",
    port: 4601,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4600", changeOrigin: false },
    },
  },
  preview: { host: "127.0.0.1", port: 4601, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
