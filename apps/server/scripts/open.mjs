#!/usr/bin/env node
// `pnpm open`: opens the Underwatch UI with the local API token (data/auth-token) in the URL.
// The token is passed only to the OS URL opener as an argument (no shell); it is never printed to stdout.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dataDir = path.resolve(process.env.KW_DATA_DIR?.trim() || path.join(repoRoot, "data"));
const tokenFile = path.join(dataDir, "auth-token");

if (!existsSync(tokenFile)) {
  console.error(`No API token at ${tokenFile}. Start the server first (pnpm dev); it creates the token on first start.`);
  process.exit(1);
}
const token = readFileSync(tokenFile, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(token)) {
  console.error(`${tokenFile} is malformed. Delete it and restart the server to generate a new token.`);
  process.exit(1);
}

// "/" is the public landing page; the app (Overview) lives at /overview.
const url = `http://127.0.0.1:4601/overview?token=${token}`;
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
execFile(opener, [url], (err) => {
  if (err) {
    // err.message would echo the command line (with the token), so only the exit code is reported.
    console.error(`Could not launch a browser (${opener}, code ${String(err.code ?? "unknown")}). Copy the "Open Underwatch" URL from the server log instead.`);
    process.exit(1);
  }
  console.log("Opened Underwatch at http://127.0.0.1:4601/overview (token passed to the browser, not printed).");
});
