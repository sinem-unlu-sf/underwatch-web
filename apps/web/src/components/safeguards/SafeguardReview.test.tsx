import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MECHANISMS, SafeguardDetailResponse, mergeClaudeMdBlock, type FileDiffPreview } from "@kw/schema";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeguardReview } from "./SafeguardReview";

const T = "2026-10-17T02:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SG = "sg_test1";
const BEFORE = "# Demo project\n\nRun tests with npm test.\n";
const INSTRUCTION = "Do not read .env or other credential files unless the user explicitly asks.";

function preview(before: string, beforeSha: string, workspaceId: string | null): FileDiffPreview {
  const after = mergeClaudeMdBlock(before, SG, INSTRUCTION);
  return {
    workspace_id: workspaceId,
    rel_path: "CLAUDE.md",
    before_exists: true,
    before_sha256: beforeSha,
    after_sha256: SHA_B,
    before,
    after,
    unified_diff: `--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,3 +1,7 @@\n${before
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => ` ${l}`)
      .join("\n")}\n+\n+<!-- underwatch:safeguard ${SG} BEGIN -->\n+${INSTRUCTION}\n+<!-- underwatch:safeguard ${SG} END -->\n`,
    duplicate_of: null,
    generated_at: T,
  };
}

const workspace = { id: "ws_demo", label: "Demo workspace", root_path: "/tmp/kw/data/workspaces/demo", kind: "demo" as const, authorized_at: T, status: "active" as const };

function makeDetail(opts: { withWorkspace: boolean; type?: "claude_md_instruction" | "hook_policy" }) {
  const type = opts.type ?? "claude_md_instruction";
  const wsId = opts.withWorkspace ? workspace.id : null;
  return SafeguardDetailResponse.parse({
    safeguard: {
      id: SG,
      finding_id: "fnd_env",
      is_fixture: false,
      type,
      title: "Avoid reading credential files",
      content: INSTRUCTION,
      application_mechanism: "append marked block to CLAUDE.md",
      target_path: "CLAUDE.md",
      intended_effect: "Agent avoids reading .env",
      legitimate_workflow_impact: "None expected",
      approval_status: "proposed",
      application_status: "not_applied",
      verification_status: "not_tested",
      created_at: T,
      approved_at: null,
      approved_by: null,
      applied_at: null,
      last_verification_run_id: null,
    },
    lifecycle_status: "proposed",
    verification_status: "not_tested",
    finding: { id: "fnd_env", title: ".env read blocked", severity: "high", run_id: "run_fx03", is_fixture: true },
    current_version: {
      id: "sgv_1",
      safeguard_id: SG,
      version: 1,
      type,
      content: INSTRUCTION,
      target: type === "claude_md_instruction" ? { kind: "workspace_file", ...(wsId ? { workspace_id: wsId } : {}), rel_path: "CLAUDE.md" } : { kind: "supervised_run_policy" },
      rationale: "The agent attempted to read .env (evt_obs1).",
      intended_effect: "Agent avoids reading .env",
      limitations: ["Guidance only."],
      verification_plan: { cases: [] },
      evidence_ids: ["evt_obs1"],
      author: "template",
      source_investigation_id: null,
      model: null,
      prompt_version: null,
      created_at: T,
    },
    versions: [],
    history: [],
    mechanism: MECHANISMS[type],
    workspace: opts.withWorkspace ? workspace : null,
    diff_preview: type === "claude_md_instruction" ? preview(BEFORE, SHA_A, wsId) : null,
    file_changes: [],
    verification_runs: [],
    allowed_transitions: ["proposed", "approved", "rejected"],
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const c: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      if (url.includes("/verification/harness")) return new Response(JSON.stringify({ available: false, checks: [] }), { status: 200 });
      const r = handler(c);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
  );
  return calls;
}

function renderReview(detail: ReturnType<typeof makeDetail>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SafeguardReview detail={detail} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SafeguardReview diff and approval", () => {
  it("shows the before/after diff, target path, and the instruction-is-not-enforcement explainer", () => {
    mockApi(() => ({ status: 500, body: {} }));
    renderReview(makeDetail({ withWorkspace: true }));
    expect(screen.getByTestId("diff-view")).toHaveTextContent(`+${INSTRUCTION}`);
    expect(screen.getByTestId("diff-view")).toHaveTextContent("/tmp/kw/data/workspaces/demo/CLAUDE.md");
    expect(screen.getAllByText(/CLAUDE.md is guidance, not a security boundary/).length).toBeGreaterThan(0);
    expect(screen.getByText("does not enforce")).toBeInTheDocument();
  });

  it("asks for explicit confirmation naming the file, sends the reviewed hash, and handles a 409 conflict with a regenerated diff", async () => {
    const user = userEvent.setup();
    const changed = "# Demo project\n\nSomeone edited this meanwhile.\n";
    const conflictPreview = preview(changed, SHA_C, workspace.id);
    let approveCount = 0;
    const calls = mockApi((c) => {
      if (c.url.endsWith("/approve")) {
        approveCount += 1;
        if (approveCount === 1) {
          return {
            status: 409,
            body: {
              error: {
                code: "file_conflict",
                message: "CLAUDE.md changed since the diff was generated",
                details: { expected_before_sha256: SHA_A, current_sha256: SHA_C, diff_preview: conflictPreview },
              },
            },
          };
        }
        return { status: 500, body: { error: { code: "internal_error", message: "stop here" } } };
      }
      return { status: 200, body: makeDetail({ withWorkspace: true }) };
    });

    renderReview(makeDetail({ withWorkspace: true }));
    await user.click(screen.getByRole("button", { name: "Approve and write" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm approval" });
    expect(dialog).toHaveTextContent("/tmp/kw/data/workspaces/demo/CLAUDE.md");
    expect(dialog).toHaveTextContent("Demo workspace");
    expect(calls.filter((c) => c.url.endsWith("/approve"))).toHaveLength(0); // nothing sent before confirming

    await user.click(screen.getByRole("button", { name: "Confirm: write to file" }));
    await waitFor(() => expect(screen.getByText(/The file changed since you reviewed the diff. Nothing was written./)).toBeInTheDocument());
    const first = calls.find((c) => c.url.endsWith("/approve"))!;
    expect(first.method).toBe("POST");
    expect(first.body).toMatchObject({ version_id: "sgv_1", workspace_id: "ws_demo", expected_before_sha256: SHA_A, confirm: true });
    expect(screen.getAllByText(/Someone edited this meanwhile./).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Review and approve again" }));
    await user.click(screen.getByRole("button", { name: "Confirm: write to file" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/approve"))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith("/approve"))[1]!.body).toMatchObject({ expected_before_sha256: SHA_C, confirm: true });
  });

  it("without an authorized workspace: approval is disabled and the patch is offered, never described as applied", async () => {
    const user = userEvent.setup();
    const patchText = `--- a/CLAUDE.md\n+++ b/CLAUDE.md\n+${INSTRUCTION}\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/patch") ? new Response(patchText, { status: 200 }) : new Response(JSON.stringify({ available: false, checks: [] }), { status: 200 }),
      ),
    );
    renderReview(makeDetail({ withWorkspace: false }));
    expect(screen.getByRole("button", { name: "Approve and write" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Copy patch" }));
    await waitFor(() => expect(screen.getByText(/It has not been applied./)).toBeInTheDocument());
    expect(screen.queryByText(/Written/)).toBeNull();
    expect(screen.getByRole("list", { name: "Safeguard status" })).toHaveTextContent("Lifecycle: Proposed");
  });

  it("marks an unavailable mechanism (hook) as unavailable and does not allow approval", () => {
    mockApi(() => ({ status: 500, body: {} }));
    renderReview(makeDetail({ withWorkspace: true, type: "hook_policy" }));
    expect(screen.getByText("unavailable in this build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run verification" })).toBeDisabled();
  });

  it("requires a reason to reject", async () => {
    const user = userEvent.setup();
    mockApi(() => ({ status: 200, body: makeDetail({ withWorkspace: true }) }));
    renderReview(makeDetail({ withWorkspace: true }));
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const submit = screen.getByRole("button", { name: "Reject proposal" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Reject reason" }), "Too broad");
    expect(submit).toBeEnabled();
  });
});
