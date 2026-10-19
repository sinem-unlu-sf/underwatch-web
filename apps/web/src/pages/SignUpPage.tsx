import { useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { EMAIL_RE, accountQueryKeys, accountsApi, passwordStrength } from "../api/accounts";
import { getToken, onTokenChange, setToken } from "../api/auth";
import { ApiRequestError } from "../api/client";
import { AuthField, AuthFormError, AuthLayout, describeAccountError } from "../components/auth/AuthLayout";
import { Button } from "../components/ds";
import { Cmd } from "../components/states";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm" | "setup_code", string>>;

const STRENGTH_TONE = ["", "text-danger", "text-caution", "text-success"] as const;

export function SignUpPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const hasStoredToken = useSyncExternalStore(onTokenChange, () => getToken() !== null, () => false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupCode, setSetupCode] = useState("");
  // The stored token was refused for account creation (e.g. it is a user session, not the local API token).
  const [tokenRefused, setTokenRefused] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsSetupCode = !hasStoredToken || tokenRefused;
  const strength = passwordStrength(password);

  function validate(): Errors {
    const e: Errors = {};
    if (!name.trim()) e.name = "Enter your name.";
    if (!email.trim()) e.email = "Enter your email.";
    else if (!EMAIL_RE.test(email.trim())) e.email = "Enter a valid email address.";
    if (password.length < 8) e.password = "Use at least 8 characters.";
    if (!confirm) e.confirm = "Confirm your password.";
    else if (confirm !== password) e.confirm = "Passwords do not match.";
    if (needsSetupCode && !setupCode.trim()) e.setup_code = "Enter the local setup code.";
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return;
    setFormError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSubmitting(true);
    try {
      const res = await accountsApi.signup({
        name: name.trim(),
        email: email.trim(),
        password,
        ...(needsSetupCode ? { setup_code: setupCode.trim() } : {}),
      });
      setToken(res.session.token);
      qc.setQueryData(accountQueryKeys.me, { user: res.user });
      await qc.invalidateQueries();
      navigate("/overview", { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.kind === "http") {
        if (err.status === 409 || err.code === "conflict") {
          setErrors({ email: "An account with this email already exists." });
          return;
        }
        if (err.status === 401 || err.status === 403 || err.code === "unauthorized" || err.code === "forbidden") {
          if (needsSetupCode) setErrors({ setup_code: "This setup code was not accepted." });
          else {
            setTokenRefused(true);
            setFormError("The access stored in this browser cannot create accounts. Enter the local setup code.");
          }
          return;
        }
        if (err.code === "validation_error") {
          setFormError(err.message || "The server rejected these details.");
          return;
        }
      }
      setFormError(describeAccountError(err, "sign up"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="A local account on this Underwatch server. Nothing leaves this machine."
      footer={
        <>
          Already have an account? <Link to="/login">Log in</Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-label="Sign up">
        {formError ? <AuthFormError>{formError}</AuthFormError> : null}
        <AuthField label="Name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <AuthField label="Email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <AuthField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={
            strength.score > 0 ? (
              <span className="flex items-center gap-2" aria-live="polite">
                <span className="flex gap-1" aria-hidden="true">
                  {[1, 2, 3].map((i) => (
                    <span key={i} className={`h-1 w-8 rounded-full ${i <= strength.score ? "bg-current" : "bg-surface-3"} ${STRENGTH_TONE[strength.score]}`} />
                  ))}
                </span>
                <span className={STRENGTH_TONE[strength.score]}>Strength: {strength.label}</span>
              </span>
            ) : (
              "At least 8 characters."
            )
          }
        />
        <AuthField
          label="Confirm password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        {needsSetupCode ? (
          <AuthField
            label="Local setup code"
            name="setup_code"
            type="password"
            autoComplete="off"
            className="field h-9 w-full font-mono"
            value={setupCode}
            onChange={(e) => setSetupCode(e.target.value)}
            error={errors.setup_code}
            hint={
              <>
                Proves you have access to this machine. Find it via <Cmd>pnpm open</Cmd> or in <Cmd>data/auth-token</Cmd> on this machine.
              </>
            }
          />
        ) : null}
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={submitting} loadingText="Creating account…">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
