/**
 * Filesystem confinement for authorized workspaces. Every path is realpath-resolved; nothing outside an authorized
 * root is ever read or written, and the only writable file name is CLAUDE.md.
 */
import { constants, existsSync, fstatSync, lstatSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ClaudeMdRelPath, MAX_CLAUDE_MD_BYTES } from "@kw/schema";
import type { ServerPaths } from "../config";
import { ApiHttpError } from "../errors";

function invalid(message: string, details?: unknown): ApiHttpError {
  return new ApiHttpError("validation_error", message, details);
}

/** a === b or a is below b (both absolute, normalized). */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export interface AuthorizeRules {
  home: string;
  dataDir: string;
  workspacesDir: string;
  evidenceDir: string;
}

export function authorizeRules(paths: ServerPaths, env: NodeJS.ProcessEnv): AuthorizeRules {
  return {
    home: env.HOME?.trim() || homedir(),
    dataDir: paths.dataDir,
    workspacesDir: paths.workspacesDir,
    evidenceDir: path.dirname(paths.blobsDir),
  };
}

/**
 * Validates a directory the user asked to authorize and returns its realpath. Throws 400 validation_error with a
 * human-readable reason otherwise.
 */
export function validateWorkspaceRoot(input: string, rules: AuthorizeRules): string {
  if (input.includes("\0")) throw invalid("Path contains a NUL byte.");
  if (!path.isAbsolute(input)) throw invalid("Workspace path must be absolute (e.g. /Users/you/code/project).");
  let real: string;
  try {
    real = realpathSync(input);
  } catch {
    throw invalid("Workspace path does not exist.");
  }
  if (!statSync(real).isDirectory()) throw invalid("Workspace path is not a directory.");
  if (real === path.parse(real).root) throw invalid("Refusing to authorize the filesystem root.");

  const home = realOrSelf(rules.home);
  if (real === home) throw invalid("Refusing to authorize your home directory itself; choose a project directory inside it.");
  if (isInside(home, real)) throw invalid("Refusing to authorize a parent of your home directory.");

  const forbidden: Array<[string, string]> = [
    [path.join(home, ".ssh"), "~/.ssh"],
    [path.join(home, ".aws"), "~/.aws"],
    [path.join(home, ".gnupg"), "~/.gnupg"],
    [path.join(home, ".underwatch"), "~/.underwatch"],
    [path.join(home, ".kernel-witness"), "~/.kernel-witness"],
    [path.join(home, "Library"), "~/Library"],
    ["/System", "/System"],
    ["/Library", "/Library"],
    ["/etc", "/etc"],
    ["/private/etc", "/etc"],
    ["/usr", "/usr"],
    ["/bin", "/bin"],
    ["/sbin", "/sbin"],
    ["/dev", "/dev"],
  ];
  for (const [dir, label] of forbidden) {
    for (const candidate of new Set([dir, realOrSelf(dir)])) {
      if (isInside(real, candidate)) throw invalid(`Refusing to authorize a directory inside ${label}.`);
    }
  }

  const evidence = realOrSelf(rules.evidenceDir);
  if (isInside(real, evidence)) throw invalid("Refusing to authorize the Underwatch evidence store (data/evidence).");
  const dataDir = realOrSelf(rules.dataDir);
  if (isInside(dataDir, real)) throw invalid("Refusing to authorize a directory that contains the Underwatch data directory.");
  if (isInside(real, dataDir) && !isInside(real, realOrSelf(rules.workspacesDir))) {
    throw invalid("Refusing to authorize Underwatch's own data directory.");
  }

  const hasGit = existsSync(path.join(real, ".git"));
  let hasClaudeMd = false;
  try {
    hasClaudeMd = lstatSync(path.join(real, "CLAUDE.md")).isFile();
  } catch {
    hasClaudeMd = false;
  }
  if (!hasGit && !hasClaudeMd) {
    throw invalid(
      "Directory is neither a git repository (no .git) nor a Claude Code project (no CLAUDE.md). Authorize the project root, " +
        "or run `git init` / create CLAUDE.md there first.",
    );
  }
  return real;
}

/** Throws 403 when the stored root no longer resolves to itself (deleted, or swapped for a symlink). */
export function checkRootIntact(root: string): boolean {
  try {
    return realpathSync(root) === root && statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a workspace-relative CLAUDE.md path to an absolute path inside `root`. Rejects anything that is not
 * CLAUDE.md / <subdir>/CLAUDE.md, escapes the root (including via symlinked directories), or is itself a symlink.
 */
export function resolveClaudeMdPath(root: string, relPath: string): string {
  const parsed = ClaudeMdRelPath.safeParse(relPath);
  if (!parsed.success) throw invalid("Only CLAUDE.md (project root or a subdirectory) may be read or written.", { rel_path: relPath });
  const abs = path.resolve(root, parsed.data);
  if (!isInside(abs, root) || abs === root) throw invalid("Path escapes the workspace root.");
  let realDir: string;
  try {
    realDir = realpathSync(path.dirname(abs));
  } catch {
    throw invalid("The directory for this CLAUDE.md does not exist in the workspace.");
  }
  if (!isInside(realDir, root)) throw invalid("Path escapes the workspace root (symlinked directory).");
  const target = path.join(realDir, "CLAUDE.md");
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) throw invalid("CLAUDE.md is a symlink; Underwatch refuses to follow it.");
    if (!st.isFile()) throw invalid("CLAUDE.md is not a regular file.");
  } catch (err) {
    if (err instanceof ApiHttpError) throw err;
    // ENOENT: the file may be created
  }
  return target;
}

/** Reads a confined file without following a final symlink; null when it does not exist. Size-capped. */
export function readConfined(abs: string, maxBytes = MAX_CLAUDE_MD_BYTES): Buffer | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw invalid("CLAUDE.md is a symlink; Underwatch refuses to follow it.");
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw invalid("CLAUDE.md is not a regular file.");
    if (st.size > maxBytes) throw invalid(`CLAUDE.md is larger than ${maxBytes} bytes; refusing to process it.`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}
