import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiPaths, claudeMdBlockMarkers } from "@kw/schema";
import type { WorkspaceService } from "../services/types";
import { mergeManagedBlock, KW_SECTION_HEADING } from "../workspaces/claude-md";
import { createTestApp, getJson, postJson, type TestContext } from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SG = "sg_test1";
const BLOCK = { safeguard_id: SG, content: "- Never read `.env` or files under `secrets/`, including via Bash (cat, python)." };

let ctx: TestContext;
let scratch: string; // outside the app's data dir
let home: string; // fake $HOME for the authorization rules
let ws: WorkspaceService;

function mkProject(name: string, files: Record<string, string> = {}, git = true): string {
  const dir = path.join(scratch, name);
  mkdirSync(dir, { recursive: true });
  if (git) mkdirSync(path.join(dir, ".git"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return realpathSync(dir);
}

async function authorize(dir: string): Promise<string> {
  const r = await postJson(ctx.app, apiPaths.workspaces(), { path: dir, label: "test", confirm: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.workspace.id as string;
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "kw-ws-")));
  home = path.join(scratch, "home");
  mkdirSync(path.join(home, ".ssh", "keys", ".git"), { recursive: true });
  ctx = await createTestApp({ HOME: home, KW_ALLOW_USER_WORKSPACES: "1" });
  ws = ctx.app.kw.services.workspaces;
  // workspace_file_changes references safeguards/versions; this suite tests the workspace module in isolation.
  ctx.db.exec("PRAGMA foreign_keys = OFF");
});
afterEach(async () => {
  await ctx.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("workspace authorization", () => {
  it("requires confirm: true and validates the directory", async () => {
    const proj = mkProject("proj", { "README.md": "x" });
    mkdirSync(path.join(path.dirname(ctx.paths.blobsDir), ".git"), { recursive: true });
    expect((await postJson(ctx.app, apiPaths.workspaces(), { path: proj, label: "p" })).status).toBe(400);
    const cases: Array<[string, RegExp]> = [
      ["relative/path", /absolute/],
      [path.join(scratch, "nope"), /does not exist/],
      [path.join(proj, "README.md"), /not a directory/],
      ["/", /root|parent of your home/],
      [home, /home directory itself/],
      [path.join(home, ".ssh", "keys"), /~\/\.ssh/],
      ["/etc", /\/etc/],
      ["/usr/bin", /\/usr/],
      [mkProject("bare", {}, false), /neither a git repository/],
      [path.dirname(ctx.paths.blobsDir), /evidence store|data directory/],
    ];
    for (const [p, re] of cases) {
      const r = await postJson(ctx.app, apiPaths.workspaces(), { path: p, label: "x", confirm: true });
      expect(r.status, p).toBe(400);
      expect(r.body.error.message, p).toMatch(re);
    }
  });

  it("resolves symlinks before checking (no symlink escape into forbidden dirs)", async () => {
    const link = path.join(scratch, "innocent");
    symlinkSync(path.join(home, ".ssh", "keys"), link);
    const r = await postJson(ctx.app, apiPaths.workspaces(), { path: link, label: "x", confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/~\/\.ssh/);
  });

  it("authorizes a git project or a CLAUDE.md project, stores the realpath, and is idempotent", async () => {
    const proj = mkProject("proj");
    const id = await authorize(proj);
    expect(await authorize(proj)).toBe(id);
    const md = mkProject("mdonly", { "CLAUDE.md": "# hi\n" }, false);
    await authorize(md);
    const link = path.join(scratch, "proj-link");
    symlinkSync(proj, link);
    expect(await authorize(link)).toBe(id);
    const list = await getJson(ctx.app, apiPaths.workspaces());
    expect(list.body.items.map((w: { root_path: string }) => w.root_path).sort()).toEqual([md, proj].sort());
  });

  it("refuses unregistered and vanished workspaces with 403", async () => {
    const r = await getJson(ctx.app, apiPaths.workspaceClaudeMd("ws_unknown"));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("workspace_not_authorized");
    const proj = mkProject("gone");
    const id = await authorize(proj);
    rmSync(proj, { recursive: true });
    expect((await getJson(ctx.app, apiPaths.workspaceClaudeMd(id))).status).toBe(403);
    expect((await getJson(ctx.app, apiPaths.workspaces())).body.items[0].status).toBe("missing");
  });
});

describe("CLAUDE.md read confinement", () => {
  it("reads CLAUDE.md and rejects traversal, other file names and symlink escapes", async () => {
    const outside = mkProject("outside", { "CLAUDE.md": "outside secret\n" });
    const proj = mkProject("proj", { "CLAUDE.md": "# proj\n", "pkg/CLAUDE.md": "# pkg\n", ".env": "KW_SYNTHETIC_SECRET=kw-test-0000\n" });
    symlinkSync(outside, path.join(proj, "escape"));
    const id = await authorize(proj);

    const ok = await getJson(ctx.app, `${apiPaths.workspaceClaudeMd(id)}?path=CLAUDE.md`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ exists: true, content: "# proj\n", sha256: sha("# proj\n") });
    expect((await getJson(ctx.app, `${apiPaths.workspaceClaudeMd(id)}?path=pkg/CLAUDE.md`)).body.content).toBe("# pkg\n");
    expect((await getJson(ctx.app, `${apiPaths.workspaceClaudeMd(id)}?path=missing/CLAUDE.md`)).status).toBe(400);

    for (const bad of ["../outside/CLAUDE.md", ".env", "README.md", "/etc/CLAUDE.md", "pkg/../CLAUDE.md", ".git/CLAUDE.md", "escape/CLAUDE.md"]) {
      const r = await getJson(ctx.app, `${apiPaths.workspaceClaudeMd(id)}?path=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain("outside secret");
    }
  });

  it("refuses a CLAUDE.md that is itself a symlink", async () => {
    const outside = mkProject("outside2", { "notes.txt": "x\n" });
    const proj = mkProject("proj2");
    symlinkSync(path.join(outside, "notes.txt"), path.join(proj, "CLAUDE.md"));
    const id = await authorize(proj);
    expect((await getJson(ctx.app, apiPaths.workspaceClaudeMd(id))).status).toBe(400);
    await expect(ws.proposeClaudeMdChange(id, "CLAUDE.md", BLOCK)).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects non-CLAUDE.md write targets at the service level", async () => {
    const id = await authorize(mkProject("proj3", { "CLAUDE.md": "x\n" }));
    for (const rel of ["README.md", "../CLAUDE.md", ".claude/settings.json", "/tmp/CLAUDE.md"]) {
      await expect(ws.proposeClaudeMdChange(id, rel, BLOCK), rel).rejects.toMatchObject({ code: "validation_error" });
      await expect(
        ws.applyChange({ workspaceId: id, relPath: rel, expectedBeforeSha256: null, block: BLOCK, safeguardId: SG, versionId: "sgv_1" }),
        rel,
      ).rejects.toMatchObject({ code: "validation_error" });
    }
    await expect(ws.proposeClaudeMdChange(null, "README.md", BLOCK)).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("CLAUDE.md proposals", () => {
  const ORIGINAL = "# Project\r\n\r\nUse   tabs\tand   odd spacing.  \n- keep this\n\n## Testing\nrun tests\n"; // CRLF + odd whitespace on purpose

  it("appends a Underwatch section and preserves unrelated content byte-for-byte", async () => {
    const id = await authorize(mkProject("p", { "CLAUDE.md": ORIGINAL }));
    const p = await ws.proposeClaudeMdChange(id, "CLAUDE.md", BLOCK);
    expect(p.before).toBe(ORIGINAL);
    expect(p.before_sha256).toBe(sha(ORIGINAL));
    expect(p.after.startsWith(ORIGINAL)).toBe(true);
    expect(p.after.slice(ORIGINAL.length)).toBe(`\n${KW_SECTION_HEADING}\n\n${claudeMdBlockMarkers(SG).begin}\n${BLOCK.content}\n${claudeMdBlockMarkers(SG).end}\n`);
    expect(p.unified_diff).toContain(`+${KW_SECTION_HEADING}`);
    expect(p.unified_diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
    expect(p.duplicate_of).toBeNull();
  });

  it("inserts under an existing Underwatch section without touching what follows", () => {
    const before = `# P\n\n${KW_SECTION_HEADING}\n- existing safeguard\n\n## Other\nkeep\n`;
    const after = mergeManagedBlock(before, SG, "- new rule");
    const { begin, end } = claudeMdBlockMarkers(SG);
    expect(after).toBe(`# P\n\n${KW_SECTION_HEADING}\n- existing safeguard\n\n${begin}\n- new rule\n${end}\n\n## Other\nkeep\n`);
    // re-version replaces only the block
    expect(mergeManagedBlock(after, SG, "- newer rule")).toBe(after.replace("- new rule", "- newer rule"));
    // no file yet
    expect(mergeManagedBlock(null, SG, "- r")).toBe(`${KW_SECTION_HEADING}\n\n${begin}\n- r\n${end}\n`);
  });

  it("detects duplicates (normalized) and proposes no change", async () => {
    const text = "# P\n\n* NEVER read `.env` or files under `secrets/`,   including via Bash (cat, python).\n";
    const id = await authorize(mkProject("dup", { "CLAUDE.md": text }));
    const p = await ws.proposeClaudeMdChange(id, "CLAUDE.md", BLOCK);
    expect(p.duplicate_of).toContain("NEVER read");
    expect(p.after).toBe(p.before);
    expect(p.unified_diff).toBe("");
  });

  it("reports simple contradictions without editing them", async () => {
    const text = "# P\n- It is fine to read .env when debugging.\n- Do not read .env in CI.\n";
    const id = await authorize(mkProject("contra", { "CLAUDE.md": text }));
    const p = await ws.proposeClaudeMdChange(id, "CLAUDE.md", BLOCK);
    expect(p.contradictions).toHaveLength(1);
    expect(p.contradictions![0]).toMatchObject({ line_number: 2, line: "- It is fine to read .env when debugging." });
    expect(p.after.startsWith(text)).toBe(true);
  });

  it("exports a git-applicable patch when no workspace is authorized", async () => {
    const patch = await ws.exportPatch(null, "CLAUDE.md", BLOCK);
    expect(patch).toContain("--- /dev/null");
    const repo = mkProject("apply", {}, false);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(path.join(scratch, "p.diff"), patch);
    execFileSync("git", ["apply", path.join(scratch, "p.diff")], { cwd: repo });
    expect(readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toBe(mergeManagedBlock(null, SG, BLOCK.content));
    // and against an existing file
    const id = await authorize(mkProject("apply2", { "CLAUDE.md": ORIGINAL }));
    const patch2 = await ws.exportPatch(id, "CLAUDE.md", BLOCK);
    const repo2 = mkProject("apply2b", { "CLAUDE.md": ORIGINAL }, false);
    execFileSync("git", ["init", "-q"], { cwd: repo2 });
    writeFileSync(path.join(scratch, "p2.diff"), patch2);
    execFileSync("git", ["apply", path.join(scratch, "p2.diff")], { cwd: repo2 });
    expect(readFileSync(path.join(repo2, "CLAUDE.md"), "utf8")).toBe(mergeManagedBlock(ORIGINAL, SG, BLOCK.content));
  });
});

describe("apply (compare-and-swap) and rollback", () => {
  it("applies atomically, stores blobs, and rolls back exactly", async () => {
    const proj = mkProject("p", { "CLAUDE.md": "# P\nkeep me\n" });
    const id = await authorize(proj);
    const p = await ws.proposeClaudeMdChange(id, "CLAUDE.md", BLOCK);
    const res = await ws.applyChange({ workspaceId: id, relPath: "CLAUDE.md", expectedBeforeSha256: p.before_sha256, block: BLOCK, safeguardId: SG, versionId: "sgv_1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const onDisk = readFileSync(path.join(proj, "CLAUDE.md"), "utf8");
    expect(onDisk).toBe(p.after);
    expect(res.change).toMatchObject({ before_sha256: sha("# P\nkeep me\n"), after_sha256: sha(p.after), status: "applied" });
    expect(ctx.app.kw.services.blobs.get(res.change.before_blob!)!.toString()).toBe("# P\nkeep me\n");
    expect(ctx.app.kw.services.blobs.get(res.change.after_blob)!.toString()).toBe(p.after);
    expect(await ws.listChanges({ safeguardId: SG })).toHaveLength(1);

    const rb = await ws.rollback(res.change.id);
    expect(rb.ok).toBe(true);
    expect(readFileSync(path.join(proj, "CLAUDE.md"), "utf8")).toBe("# P\nkeep me\n");
    expect((await ws.getChange(res.change.id))!.status).toBe("rolled_back");
    expect((await ws.rollback(res.change.id)).ok).toBe(true); // idempotent
  });

  it("returns a conflict with a regenerated diff when the file changed since review (nothing written)", async () => {
    const proj = mkProject("p", { "CLAUDE.md": "# P\n" });
    const id = await authorize(proj);
    const p = await ws.proposeClaudeMdChange(id, "CLAUDE.md", BLOCK);
    writeFileSync(path.join(proj, "CLAUDE.md"), "# P\n- edited by someone else\n");
    const res = await ws.applyChange({ workspaceId: id, relPath: "CLAUDE.md", expectedBeforeSha256: p.before_sha256, block: BLOCK, safeguardId: SG, versionId: "sgv_1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict.expected_before_sha256).toBe(sha("# P\n"));
    expect(res.conflict.current_sha256).toBe(sha("# P\n- edited by someone else\n"));
    expect(res.conflict.diff_preview.before).toBe("# P\n- edited by someone else\n");
    expect(res.conflict.diff_preview.after.startsWith("# P\n- edited by someone else\n")).toBe(true);
    expect(readFileSync(path.join(proj, "CLAUDE.md"), "utf8")).toBe("# P\n- edited by someone else\n");
    expect(await ws.listChanges({ safeguardId: SG })).toHaveLength(0);
    // approving the regenerated diff works
    const again = await ws.applyChange({ workspaceId: id, relPath: "CLAUDE.md", expectedBeforeSha256: res.conflict.current_sha256, block: BLOCK, safeguardId: SG, versionId: "sgv_1" });
    expect(again.ok).toBe(true);
  });

  it("creates a missing CLAUDE.md (expected null) and rollback deletes it; rollback refuses after a later edit", async () => {
    const proj = mkProject("p");
    const id = await authorize(proj);
    const wrong = await ws.applyChange({ workspaceId: id, relPath: "CLAUDE.md", expectedBeforeSha256: sha("x"), block: BLOCK, safeguardId: SG, versionId: "sgv_1" });
    expect(wrong.ok).toBe(false);
    const res = await ws.applyChange({ workspaceId: id, relPath: "CLAUDE.md", expectedBeforeSha256: null, block: BLOCK, safeguardId: SG, versionId: "sgv_1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rb = await ws.rollback(res.change.id);
    expect(rb.ok).toBe(true);
    expect(existsSync(path.join(proj, "CLAUDE.md"))).toBe(false);

    const res2 = await ws.applyChange({ workspaceId: id, relPath: "CLAUDE.md", expectedBeforeSha256: null, block: BLOCK, safeguardId: SG, versionId: "sgv_2" });
    if (!res2.ok) throw new Error("expected ok");
    writeFileSync(path.join(proj, "CLAUDE.md"), "user rewrote it\n");
    const rb2 = await ws.rollback(res2.change.id);
    expect(rb2.ok).toBe(false);
    if (rb2.ok) return;
    expect(rb2.conflict.expected_before_sha256).toBe(res2.change.after_sha256);
    expect(readFileSync(path.join(proj, "CLAUDE.md"), "utf8")).toBe("user rewrote it\n");
    expect((await ws.getChange(res2.change.id))!.status).toBe("applied");
  });
});

describe("demo workspace", () => {
  it("creates the demo repo from the template with git history, and resets it", async () => {
    const r = await postJson(ctx.app, apiPaths.workspaceDemo(), {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reset).toBe(false);
    expect(r.body.workspace.kind).toBe("demo");
    const root: string = r.body.workspace.root_path;
    expect(root).toBe(path.join(realpathSync(ctx.paths.workspacesDir), "demo-repo"));
    expect(r.body.files).toEqual(expect.arrayContaining([".env", ".gitignore", "CLAUDE.md", "README.md", "secrets/token.txt", "src/app.py", "tests/test_app.py"]));
    expect(readFileSync(path.join(root, ".env"), "utf8")).toContain("KW_SYNTHETIC_SECRET=kw-test-0000");
    expect(readFileSync(path.join(root, "secrets/token.txt"), "utf8").trim()).toBe("kw-test-token-1111");
    expect(existsSync(path.join(root, "_gitignore"))).toBe(false);
    const log = execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    expect(log).toHaveLength(1);
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    expect(tracked).not.toContain(".env\n");

    const md = await getJson(ctx.app, apiPaths.workspaceClaudeMd(r.body.workspace.id));
    expect(md.body.content).toContain("## Project instructions");

    const snap = await ws.snapshot(r.body.workspace.id);
    expect(snap.files.map((f) => f.rel_path)).toContain("secrets/token.txt");
    expect(snap.files.some((f) => f.rel_path.startsWith(".git/"))).toBe(false);

    writeFileSync(path.join(root, "CLAUDE.md"), "tampered\n");
    const again = await postJson(ctx.app, apiPaths.workspaceDemo(), {});
    expect(again.body.reset).toBe(true);
    expect(again.body.workspace.id).toBe(r.body.workspace.id);
    expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("## Project instructions");
  });
});

describe("user workspaces are opt-in (KW_ALLOW_USER_WORKSPACES)", () => {
  it("refuses to register a real project folder by default, but still serves the demo workspace", async () => {
    const locked = await createTestApp({ HOME: home });
    try {
      const proj = mkProject("real-project", { "CLAUDE.md": "# mine\n" });
      const r = await postJson(locked.app, apiPaths.workspaces(), { path: proj, label: "real", confirm: true });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect((await getJson(locked.app, apiPaths.workspaces())).body.items).toHaveLength(0);
      expect(readFileSync(path.join(proj, "CLAUDE.md"), "utf8")).toBe("# mine\n");

      const demo = await postJson(locked.app, apiPaths.workspaceDemo(), {});
      expect(demo.status, JSON.stringify(demo.body)).toBe(200);
      expect(demo.body.workspace.kind).toBe("demo");
      // Re-authorizing the demo root itself stays allowed.
      const again = await postJson(locked.app, apiPaths.workspaces(), { path: demo.body.workspace.root_path, label: "demo", confirm: true });
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body.workspace.kind).toBe("demo");
    } finally {
      await locked.close();
    }
  });
});
