import { useEffect, useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { Link } from "react-router";
import { ApiRequestError } from "../../api/client";
import { Icon } from "../ds";
import { LogoMark } from "../shell/nav";

/** Minimal centered page for /signup and /login (no app shell), matching the landing page's dark Linear-style look. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Underwatch`;
  }, [title]);
  return (
    <div className="flex min-h-dvh flex-col bg-bg px-4 text-text">
      <header className="mx-auto flex w-full max-w-5xl items-center py-5">
        <Link to="/" className="flex items-center gap-2 text-[14px] font-medium text-text no-underline">
          <LogoMark size={22} />
          Underwatch
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center pb-16 pt-[8vh]">
        <div className="w-full max-w-[380px]">
          <div className="mb-6 flex flex-col items-center text-center">
            <LogoMark size={36} />
            <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.01em] text-text">{title}</h1>
            {subtitle ? <p className="mt-1.5 text-[13px] text-text-secondary">{subtitle}</p> : null}
          </div>
          {children}
          {footer ? <div className="mt-6 text-center text-[13px] text-text-secondary">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}

/** Labelled input with an inline error right under it (aria-invalid + aria-describedby). */
export function AuthField({
  label,
  error,
  hint,
  inputRef,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: ReactNode; inputRef?: Ref<HTMLInputElement> }) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-medium text-fg-1">
        {label}
      </label>
      <input id={id} ref={inputRef} className="field h-9 w-full" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint ? (
        <div id={hintId} className="text-[11.5px] text-text-secondary">
          {hint}
        </div>
      ) : null}
      {error ? (
        <p id={errId} className="flex items-center gap-1 text-[12px] text-danger">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Form-level failure that is not tied to one field. */
export function AuthFormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-1.5 rounded-md border border-risk/50 bg-risk/8 p-2.5 text-[12.5px] text-fg-1">
      <Icon name="alert" size={13} className="mt-[2px] shrink-0 text-danger" />
      <div>{children}</div>
    </div>
  );
}

/** Honest, specific wording for the API failure kinds; never claims success. */
export function describeAccountError(err: unknown, action: "sign up" | "log in"): string {
  if (!(err instanceof ApiRequestError)) return err instanceof Error ? err.message : `Could not ${action}.`;
  if (err.kind === "unreachable") return "The Underwatch API is not reachable. Start it with pnpm dev (or pnpm open) and try again.";
  if (err.kind === "contract") return `The server answered with an unexpected response (HTTP ${err.status ?? "?"}). Nothing was stored in this browser.`;
  if (err.status === 404 || err.code === "not_found" || err.code === "not_implemented")
    return "Accounts are not available on this server build yet. You can still use the local access token.";
  if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
  return err.message || `Could not ${action}.`;
}
