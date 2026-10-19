import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ClaudeMdRelPath } from "@kw/schema";
import type { AuthorizeWorkspaceBody, FileConflictDetails, FileDiffPreview, Workspace, WorkspaceFileChange } from "@kw/schema";
import type { ServerContext } from "../context";
import { stmt } from "../db/codec";
import { ApiHttpError, notFound } from "../errors";
import type { ApplyChangeResult, ClaudeMdRead, ManagedBlock, WorkspaceService, WorkspaceSnapshot } from "../services/types";
import { containsMarker, findContradictions, findDuplicate, mergeManagedBlock, unifiedDiff } from "./claude-md";
import { authorizeRules, checkRootIntact, isInside, readConfined, resolveClaudeMdPath, validateWorkspaceRoot } from "./paths";

export const DEMO_WORKSPACE_DIRNAME = "demo-repo";
const DEMO_LABEL = "Demo workspace (synthetic secrets)";
/** Template files stored under another name so they do not affect the Underwatch repo itself. */
const TEMPLATE_RENAMES: Record<string, string> = { _gitignore: ".gitignore" };

const SNAPSHOT_SKIP = new Set([".git", "node_modules", "__pycache__", ".venv"]);
const SNAPSHOT_MAX_FILES = 2000;
const SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

interface WorkspaceRow {
  id: string;
  label: string;
  root_path: string;
  kind: "demo" | "user";
  authorized_at: string;
  status: "active" | "missing" | "revoked";
}

interface ChangeRow {
  id: string;
  workspace_id: string;
  safeguard_id: string;
  version_id: string;
  rel_path: string;
  before_sha256: string | null;
  after_sha256: string;
  before_blob: string | null;
  after_blob: string;
  status: "applied" | "rolled_back";
  applied_at: string;
  rolled_back_at: string | null;
}

const WS_COLS = "id, label, root_path, kind, authorized_at, status";
const CHANGE_COLS =
  "id, workspace_id, safeguard_id, version_id, rel_path, before_sha256, after_sha256, before_blob, after_blob, status, applied_at, rolled_back_at";

function toWorkspace(r: WorkspaceRow): Workspace {
  return { id: r.id, label: r.label, root_path: r.root_path, kind: r.kind, authorized_at: r.authorized_at, status: r.status };
}

function toChange(r: ChangeRow): WorkspaceFileChange {
  return { ...r };
}

function notAuthorized(id: string, why: string): ApiHttpError {
  return new ApiHttpError("workspace_not_authorized", `Workspace "${id}" is not authorized: ${why}`);
}

/** Lists template files (workspace-relative, after renames), skipping caches. */
function listTemplateFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, base), { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === ".DS_Store") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTemplateFiles(dir, rel));
    else if (entry.isFile()) out.push(rel.split("/").map((seg) => TEMPLATE_RENAMES[seg] ?? seg).join("/"));
  }
  return out.sort();
}

/**
 * Atomic write inside a directory that was already confined: temp file in the same directory (O_EXCL), fsync, then
 * rename over the target. `verify` runs immediately before the rename (last compare-and-swap check).
 */
function atomicWrite(target: string, data: string, verify: () => void): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.CLAUDE.md.kw-tmp-${process.pid}-${randomUUID()}`);
  let mode = 0o644;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    // new file
  }
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    verify();
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    timeout: 15_000,
    // Isolated from the developer's global/system git config, hooks and templates.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: cwd },
  });
}

export function createWorkspaceService(ctx: ServerContext): WorkspaceService {
  const db = () => ctx.db;
  const now = () => ctx.now().toISOString();

  function rowById(id: string): WorkspaceRow | undefined {
    return stmt(db(), `SELECT ${WS_COLS} FROM workspaces WHERE id = ?`).get(id) as WorkspaceRow | undefined;
  }

  function rowByRoot(root: string): WorkspaceRow | undefined {
    return stmt(db(), `SELECT ${WS_COLS} FROM workspaces WHERE root_path = ?`).get(root) as WorkspaceRow | undefined;
  }

  /** Marks active rows whose root vanished as missing (and missing rows that came back as active). */
  function refresh(r: WorkspaceRow): WorkspaceRow {
    if (r.status === "revoked") return r;
    const status = checkRootIntact(r.root_path) ? "active" : "missing";
    if (status !== r.status) {
      stmt(db(), "UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), r.id);
      return { ...r, status };
    }
    return r;
  }

  function upsert(root: string, label: string, kind: "demo" | "user"): Workspace {
    const ts = now();
    const existing = rowByRoot(root);
    if (existing) {
      stmt(db(), "UPDATE workspaces SET label = ?, kind = ?, status = 'active', authorized_at = ?, updated_at = ? WHERE id = ?").run(
        label,
        kind,
        ts,
        ts,
        existing.id,
      );
      return toWorkspace(rowById(existing.id)!);
    }
    const id = `ws_${randomUUID().replace(/-/g, "")}`;
    stmt(
      db(),
      "INSERT INTO workspaces (id, label, root_path, kind, authorized_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    ).run(id, label, root, kind, ts, ts, ts);
    return toWorkspace(rowById(id)!);
  }

  async function requireWorkspace(id: string): Promise<Workspace> {
    const r = rowById(id);
    if (!r) throw notAuthorized(id, "it was never authorized.");
    if (r.status === "revoked") throw notAuthorized(id, "its authorization was revoked.");
    const fresh = refresh(r);
    if (fresh.status !== "active") throw notAuthorized(id, "its directory no longer exists (or was replaced by a symlink).");
    return toWorkspace(fresh);
  }

  function readFile(root: string, relPath: string): { abs: string; read: ClaudeMdRead; text: string | null } {
    const abs = resolveClaudeMdPath(root, relPath);
    const buf = readConfined(abs);
    if (buf === null) return { abs, text: null, read: { content: null, sha256: null, size_bytes: null } };
    const text = buf.toString("utf8");
    return { abs, text, read: { content: text, sha256: sha256(buf), size_bytes: buf.length } };
  }

  function checkBlock(block: ManagedBlock): void {
    if (containsMarker(block.content)) {
      throw new ApiHttpError("validation_error", "Safeguard content must not contain Underwatch block markers.");
    }
    if (block.content.trim().length === 0) throw new ApiHttpError("validation_error", "Safeguard content is empty.");
  }

  function preview(workspaceId: string | null, relPath: string, before: string | null, beforeSha: string | null, block: ManagedBlock): FileDiffPreview {
    const duplicate = findDuplicate(before, block.safeguard_id, block.content);
    const after = duplicate !== null && before !== null ? before : mergeManagedBlock(before, block.safeguard_id, block.content);
    return {
      workspace_id: workspaceId,
      rel_path: relPath,
      before_exists: before !== null,
      before_sha256: beforeSha,
      after_sha256: sha256(after),
      before,
      after,
      unified_diff: unifiedDiff(relPath, before, after),
      duplicate_of: duplicate,
      contradictions: findContradictions(before, block.content),
      generated_at: now(),
    };
  }

  function changeRow(id: string): ChangeRow | undefined {
    return stmt(db(), `SELECT ${CHANGE_COLS} FROM workspace_file_changes WHERE id = ?`).get(id) as ChangeRow | undefined;
  }

  const service: WorkspaceService = {
    async listWorkspaces() {
      const rows = stmt(db(), `SELECT ${WS_COLS} FROM workspaces ORDER BY created_at, id`).all() as unknown as WorkspaceRow[];
      return rows.map((r) => toWorkspace(refresh(r)));
    },

    async getWorkspace(id) {
      const r = rowById(id);
      return r ? toWorkspace(refresh(r)) : null;
    },

    requireWorkspace,

    async authorizeWorkspace(body: AuthorizeWorkspaceBody) {
      if (body.confirm !== true) throw new ApiHttpError("validation_error", "Explicit confirmation (confirm: true) is required.");
      const root = validateWorkspaceRoot(body.path, authorizeRules(ctx.paths, ctx.env));
      const isDemo = rowByRoot(root)?.kind === "demo";
      // Hackathon default: only the disposable demo workspace is writable unless the operator opts in.
      if (!isDemo && ctx.env.KW_ALLOW_USER_WORKSPACES !== "1") {
        throw new ApiHttpError(
          "forbidden",
          "Registering your own project folders is turned off in this build. Use the demo workspace, or restart the server with KW_ALLOW_USER_WORKSPACES=1 to allow it.",
        );
      }
      const ws = upsert(root, body.label, isDemo ? "demo" : "user");
      ctx.log.info({ workspace_id: ws.id, root_path: ws.root_path }, "workspace authorized");
      return ws;
    },

    async createDemoWorkspace() {
      const template = ctx.paths.demoTemplateDir;
      if (!existsSync(template)) throw new ApiHttpError("internal_error", "Demo workspace template is missing.");
      mkdirSync(ctx.paths.workspacesDir, { recursive: true });
      const target = path.join(ctx.paths.workspacesDir, DEMO_WORKSPACE_DIRNAME);
      if (!isInside(path.resolve(target), path.resolve(ctx.paths.workspacesDir)) || path.resolve(target) === path.resolve(ctx.paths.workspacesDir)) {
        throw new ApiHttpError("internal_error", "Demo workspace path is outside data/workspaces.");
      }
      const reset = existsSync(target);
      if (reset) {
        if (lstatSync(target).isSymbolicLink()) throw new ApiHttpError("internal_error", "Demo workspace path is a symlink; refusing to reset it.");
        rmSync(target, { recursive: true, force: true });
      }
      cpSync(template, target, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !/(^|\/)(__pycache__|\.DS_Store)$/.test(src),
      });
      for (const [from, to] of Object.entries(TEMPLATE_RENAMES)) {
        if (existsSync(path.join(target, from))) renameSync(path.join(target, from), path.join(target, to));
      }
      try {
        runGit(target, ["init", "-q", "--template=", "-b", "main"]);
        runGit(target, ["add", "-A"]);
        runGit(target, [
          "-c",
          "user.name=Underwatch",
          "-c",
          "user.email=demo@underwatch.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-q",
          "-m",
          "Initial demo workspace (synthetic secrets only)",
        ]);
      } catch (err) {
        // The workspace is still usable without git history; say so in the log rather than failing the request.
        ctx.log.warn({ err: (err as Error).message }, "demo workspace: git init/commit failed");
      }
      const workspace = upsert(realpathSync(target), DEMO_LABEL, "demo");
      return { workspace, reset, files: listTemplateFiles(template) };
    },

    async readClaudeMd(workspaceId, relPath) {
      const ws = await requireWorkspace(workspaceId);
      return readFile(ws.root_path, relPath).read;
    },

    async proposeClaudeMdChange(workspaceId, relPath, block) {
      checkBlock(block);
      if (workspaceId === null) {
        if (!ClaudeMdRelPath.safeParse(relPath).success) {
          throw new ApiHttpError("validation_error", "Only CLAUDE.md (project root or a subdirectory) may be targeted.", { rel_path: relPath });
        }
        return preview(null, relPath, null, null, block);
      }
      const ws = await requireWorkspace(workspaceId);
      const { text, read } = readFile(ws.root_path, relPath);
      return preview(ws.id, relPath, text, read.sha256, block);
    },

    async applyChange(input): Promise<ApplyChangeResult> {
      checkBlock(input.block);
      const ws = await requireWorkspace(input.workspaceId);
      const { abs, text, read } = readFile(ws.root_path, input.relPath);
      if (read.sha256 !== input.expectedBeforeSha256) {
        const conflict: FileConflictDetails = {
          expected_before_sha256: input.expectedBeforeSha256,
          current_sha256: read.sha256,
          diff_preview: preview(ws.id, input.relPath, text, read.sha256, input.block),
        };
        return { ok: false, conflict };
      }
      const after = mergeManagedBlock(text, input.block.safeguard_id, input.block.content);
      const beforeRef = text === null ? null : ctx.services.blobs.put(text);
      const afterRef = ctx.services.blobs.put(after);
      let lateConflict: string | null | undefined;
      try {
        atomicWrite(abs, after, () => {
          const again = readConfined(abs);
          const sha = again === null ? null : sha256(again);
          if (sha !== read.sha256) {
            lateConflict = sha;
            throw new Error("concurrent modification");
          }
        });
      } catch (err) {
        if (lateConflict !== undefined) {
          const latest = readFile(ws.root_path, input.relPath);
          return {
            ok: false,
            conflict: {
              expected_before_sha256: input.expectedBeforeSha256,
              current_sha256: latest.read.sha256,
              diff_preview: preview(ws.id, input.relPath, latest.text, latest.read.sha256, input.block),
            },
          };
        }
        throw err;
      }
      const change: ChangeRow = {
        id: `wfc_${randomUUID().replace(/-/g, "")}`,
        workspace_id: ws.id,
        safeguard_id: input.safeguardId,
        version_id: input.versionId,
        rel_path: input.relPath,
        before_sha256: read.sha256,
        after_sha256: afterRef.sha256,
        before_blob: beforeRef?.sha256 ?? null,
        after_blob: afterRef.sha256,
        status: "applied",
        applied_at: now(),
        rolled_back_at: null,
      };
      stmt(db(), `INSERT INTO workspace_file_changes (${CHANGE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        change.id,
        change.workspace_id,
        change.safeguard_id,
        change.version_id,
        change.rel_path,
        change.before_sha256,
        change.after_sha256,
        change.before_blob,
        change.after_blob,
        change.status,
        change.applied_at,
        change.rolled_back_at,
      );
      ctx.log.info({ change_id: change.id, workspace_id: ws.id, rel_path: change.rel_path }, "CLAUDE.md change applied");
      return { ok: true, change: toChange(change) };
    },

    async rollback(changeId): Promise<ApplyChangeResult> {
      const row = changeRow(changeId);
      if (!row) throw notFound("Workspace file change", changeId);
      if (row.status === "rolled_back") return { ok: true, change: toChange(row) };
      const ws = await requireWorkspace(row.workspace_id);
      const { abs, text, read } = readFile(ws.root_path, row.rel_path);
      const before = row.before_blob === null ? null : ctx.services.blobs.get(row.before_blob);
      if (row.before_blob !== null && before === null) throw new ApiHttpError("internal_error", "The stored before-content blob is missing.");
      const beforeText = before === null ? null : before.toString("utf8");
      const conflictFor = (current: string | null, currentSha: string | null): ApplyChangeResult => ({
        ok: false,
        conflict: {
          expected_before_sha256: row.after_sha256,
          current_sha256: currentSha,
          diff_preview: {
            workspace_id: ws.id,
            rel_path: row.rel_path,
            before_exists: current !== null,
            before_sha256: currentSha,
            after_sha256: sha256(beforeText ?? ""),
            before: current,
            after: beforeText ?? "",
            unified_diff: unifiedDiff(row.rel_path, current, beforeText ?? ""),
            duplicate_of: null,
            generated_at: now(),
          },
        },
      });
      if (read.sha256 !== row.after_sha256) return conflictFor(text, read.sha256);
      let late = false;
      const verify = () => {
        const again = readConfined(abs);
        if ((again === null ? null : sha256(again)) !== row.after_sha256) {
          late = true;
          throw new Error("concurrent modification");
        }
      };
      try {
        if (beforeText === null) {
          verify();
          unlinkSync(abs);
        } else {
          atomicWrite(abs, beforeText, verify);
        }
      } catch (err) {
        if (late) {
          const latest = readFile(ws.root_path, row.rel_path);
          return conflictFor(latest.text, latest.read.sha256);
        }
        throw err;
      }
      const ts = now();
      stmt(db(), "UPDATE workspace_file_changes SET status = 'rolled_back', rolled_back_at = ? WHERE id = ? AND status = 'applied'").run(ts, row.id);
      ctx.log.info({ change_id: row.id, workspace_id: ws.id }, "CLAUDE.md change rolled back");
      return { ok: true, change: toChange(changeRow(row.id)!) };
    },

    async getChange(changeId) {
      const r = changeRow(changeId);
      return r ? toChange(r) : null;
    },

    async listChanges({ safeguardId }) {
      const rows = stmt(db(), `SELECT ${CHANGE_COLS} FROM workspace_file_changes WHERE safeguard_id = ? ORDER BY applied_at, id`).all(
        safeguardId,
      ) as unknown as ChangeRow[];
      return rows.map(toChange);
    },

    async exportPatch(workspaceId, relPath, block) {
      return (await service.proposeClaudeMdChange(workspaceId, relPath, block)).unified_diff;
    },

    async snapshot(workspaceId): Promise<WorkspaceSnapshot> {
      const ws = await requireWorkspace(workspaceId);
      const files: WorkspaceSnapshot["files"] = [];
      let total = 0;
      const walk = (relDir: string) => {
        for (const entry of readdirSync(path.join(ws.root_path, relDir), { withFileTypes: true })) {
          if (SNAPSHOT_SKIP.has(entry.name)) continue;
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(rel);
          else if (entry.isFile()) {
            if (lstatSync(path.join(ws.root_path, rel)).size > SNAPSHOT_MAX_FILE_BYTES) continue; // oversized files are not copied
            if (files.length >= SNAPSHOT_MAX_FILES) throw new ApiHttpError("validation_error", `Workspace has more than ${SNAPSHOT_MAX_FILES} files; snapshot refused.`);
            const bytes = readConfined(path.join(ws.root_path, rel), SNAPSHOT_MAX_FILE_BYTES);
            if (bytes === null) continue;
            total += bytes.length;
            if (total > SNAPSHOT_MAX_TOTAL_BYTES) throw new ApiHttpError("validation_error", "Workspace is too large to snapshot.");
            files.push({ rel_path: rel, sha256: sha256(bytes), bytes });
          }
          // symlinks and special files are skipped (never followed)
        }
      };
      walk("");
      files.sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));
      const manifest = files.map((f) => `${f.rel_path}\t${f.sha256}\n`).join("");
      return { workspace_id: ws.id, manifest_sha256: sha256(manifest), files };
    },
  };
  return service;
}
