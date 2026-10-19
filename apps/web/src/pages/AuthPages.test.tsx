import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../api/auth";
import { SessionControl } from "../components/shell/TopBar";
import { PermissionDenied } from "../components/states";
import { LoginPage } from "./LoginPage";
import { SignUpPage } from "./SignUpPage";

const USER = { id: "usr_1", name: "Ada Lovelace", email: "ada@example.com", created_at: "2026-10-17T04:00:00.000Z" };
const SESSION = { token: "sess_abc123", expires_at: "2026-10-24T04:00:00.000Z" };

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let handler: (path: string, method: string, body: unknown) => Response;

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  handler = () => reply(404, { error: { code: "not_found", message: "no mock" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method, headers: (init?.headers ?? {}) as Record<string, string>, body });
      return handler(url.pathname, method, body);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/signup" element={<SignUpPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/overview" element={<div>OVERVIEW PAGE</div>} />
          <Route path="/session" element={<SessionControl />} />
          <Route path="/denied" element={<PermissionDenied />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SignUpPage", () => {
  it("shows inline validation errors next to fields and sends nothing", async () => {
    const user = userEvent.setup();
    renderAt("/signup");
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Enter your name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(screen.getByText("Enter the local setup code.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(calls.filter((c) => c.path.startsWith("/api/accounts"))).toHaveLength(0);
  });

  it("asks for the setup code without a stored token, stores the session and goes to /overview", async () => {
    handler = (path) => (path === "/api/accounts/signup" ? reply(201, { user: USER, session: SESSION }) : reply(404, { error: { code: "not_found", message: "x" } }));
    const user = userEvent.setup();
    renderAt("/signup");
    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-42");
    expect(screen.getByText(/Strength: Strong/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-42");
    expect(screen.getByText(/data\/auth-token/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Local setup code"), "local-master-code");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("OVERVIEW PAGE")).toBeInTheDocument();
    const call = calls.find((c) => c.path === "/api/accounts/signup")!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ name: "Ada Lovelace", email: "ada@example.com", password: "correct-horse-42", setup_code: "local-master-code" });
    expect(call.headers.Authorization).toBe("Bearer local-master-code");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(SESSION.token);
  });

  it("hides the setup code when a token is stored and shows a conflict next to the email field", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "local-master-code");
    handler = () => reply(409, { error: { code: "conflict", message: "email taken" } });
    const user = userEvent.setup();
    renderAt("/signup");
    expect(screen.queryByLabelText("Local setup code")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-42");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-42");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("An account with this email already exists.")).toBeInTheDocument();
    const call = calls.find((c) => c.path === "/api/accounts/signup")!;
    expect(call.headers.Authorization).toBe("Bearer local-master-code");
    expect(call.body).not.toHaveProperty("setup_code");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("local-master-code");
  });

  it("reports honestly when the accounts API does not exist on this server", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "local-master-code");
    const user = userEvent.setup();
    renderAt("/signup");
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-42");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-42");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Accounts are not available on this server build yet");
    expect(screen.queryByText("OVERVIEW PAGE")).not.toBeInTheDocument();
  });
});

describe("LoginPage", () => {
  it("shows a generic error on bad credentials", async () => {
    handler = () => reply(401, { error: { code: "unauthorized", message: "invalid credentials" } });
    const user = userEvent.setup();
    renderAt("/login");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("stores the session token and navigates to /overview", async () => {
    handler = (path) => (path === "/api/accounts/login" ? reply(200, { user: USER, session: SESSION }) : reply(404, { error: { code: "not_found", message: "x" } }));
    const user = userEvent.setup();
    renderAt("/login");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-42");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("OVERVIEW PAGE")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/accounts/login")!.body).toEqual({ email: "ada@example.com", password: "correct-horse-42" });
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(SESSION.token);
  });
});

describe("Session menu + permission denied", () => {
  it("shows the signed-in user and logs out to /login", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, SESSION.token);
    handler = (path) => {
      if (path === "/api/accounts/me") return reply(200, { user: USER });
      if (path === "/api/accounts/logout") return reply(204);
      if (path === "/api/auth/check") return reply(200, { authenticated: true, actor: "local", mode: "token", detail: "ok" });
      return reply(404, { error: { code: "not_found", message: "x" } });
    };
    const user = userEvent.setup();
    renderAt("/session");
    await user.click(await screen.findByRole("button", { name: "Account: Ada Lovelace" }));
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Log in to Underwatch" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/accounts/logout" && c.method === "POST")).toBe(true);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("keeps the local-session menu when the stored token is not an account session", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "local-master-code");
    handler = (path) =>
      path === "/api/accounts/me" ? reply(401, { error: { code: "unauthorized", message: "no session" } }) : reply(200, { authenticated: true, actor: "local", mode: "token", detail: "ok" });
    const user = userEvent.setup();
    renderAt("/session");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/accounts/me")).toBe(true));
    await user.click(screen.getByRole("button", { name: "Local session" }));
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("button", { name: "Clear stored token…" })).toBeInTheDocument();
  });

  it("permission-denied screen offers Log in and Sign up besides the token paste", () => {
    renderAt("/denied");
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("button", { name: "Use token" })).toBeInTheDocument();
  });
});
