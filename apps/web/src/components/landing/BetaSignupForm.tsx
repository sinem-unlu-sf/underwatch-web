import { useState, type FormEvent } from "react";
import { BETA_CTA } from "./landingContent";

type Kind = "individual" | "company";
type Result = { status: "created" | "exists"; emailed: boolean; email: string };

const input =
  "h-10 w-full rounded-md border border-border-strong bg-white/[0.03] px-3 text-[14px] text-text placeholder:text-text-tertiary focus:border-accent focus:outline-none";

/** Beta sign-up for the static landing page; posts to the Vercel Function in api/beta-signup.ts. */
export function BetaSignupForm() {
  const [kind, setKind] = useState<Kind>("individual");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/beta-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, email, company: kind === "company" ? company : "", website }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: Result["status"]; emailed?: boolean; error?: string };
      if (!res.ok || !body.status) throw new Error(body.error ?? "Something went wrong. Please try again.");
      setResult({ status: body.status, emailed: body.emailed === true, email: email.trim() });
    } catch (err) {
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Could not reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <div role="status" className="mx-auto mt-8 max-w-[520px] rounded-lg border border-border-strong bg-white/[0.03] px-5 py-4 text-[14px] leading-relaxed">
        <p className="font-medium text-text">{result.status === "created" ? "You're on the list." : "You're already on the list."}</p>
        <p className="mt-1 text-text-secondary">
          {result.emailed
            ? `We sent a confirmation to ${result.email}, and we will email you there when the beta opens.`
            : `We will email ${result.email} when the beta opens.`}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-8 flex max-w-[520px] flex-col gap-3 text-left">
      <p className="text-center text-[15px] text-text-secondary">Get early access for yourself or your team.</p>
      <fieldset className="flex justify-center">
        <legend className="sr-only">Signing up as</legend>
        <div className="inline-flex rounded-md border border-border-strong bg-white/[0.03] p-0.5 text-[13px]">
          {(["individual", "company"] as const).map((k) => (
            <label
              key={k}
              className={`cursor-pointer rounded-[5px] px-3 py-1.5 transition-colors duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-accent ${
                kind === k ? "bg-white/[0.1] text-text" : "text-text-secondary hover:text-text"
              }`}
            >
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
              {k === "individual" ? "Individual" : "Company"}
            </label>
          ))}
        </div>
      </fieldset>
      {kind === "company" && (
        <label className="block">
          <span className="sr-only">Company name</span>
          <input
            className={input}
            name="company"
            autoComplete="organization"
            placeholder="Company name"
            required
            maxLength={120}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="block flex-1">
          <span className="sr-only">Email</span>
          <input
            className={input}
            type="email"
            name="email"
            autoComplete="email"
            placeholder={kind === "company" ? "Work email" : "Email"}
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-[#EDEDF0] px-4 text-[14px] font-medium text-[#09090B] transition-colors duration-150 hover:bg-white disabled:opacity-60"
        >
          {pending ? "Joining…" : BETA_CTA}
        </button>
      </div>
      {/* Honeypot: hidden from people and assistive tech; bots that fill it are dropped server-side. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-px w-px opacity-0"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-center text-[13px] text-danger">
          {error}
        </p>
      )}
      <p className="text-center text-[12px] text-text-tertiary">We only use your email to contact you about the Underwatch beta.</p>
    </form>
  );
}
