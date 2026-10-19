import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { EMAIL_RE, accountQueryKeys, accountsApi } from "../api/accounts";
import { setToken } from "../api/auth";
import { ApiRequestError } from "../api/client";
import { AuthField, AuthFormError, AuthLayout, describeAccountError } from "../components/auth/AuthLayout";
import { Button } from "../components/ds";

type Errors = Partial<Record<"email" | "password", string>>;

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return;
    setFormError(null);
    const e: Errors = {};
    if (!email.trim()) e.email = "Enter your email.";
    else if (!EMAIL_RE.test(email.trim())) e.email = "Enter a valid email address.";
    if (!password) e.password = "Enter your password.";
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSubmitting(true);
    try {
      const res = await accountsApi.login(email.trim(), password);
      setToken(res.session.token);
      qc.setQueryData(accountQueryKeys.me, { user: res.user });
      await qc.invalidateQueries();
      navigate("/overview", { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.kind === "http" && (err.status === 401 || err.code === "unauthorized" || err.code === "validation_error")) {
        // Generic on purpose: do not reveal whether the email exists.
        setFormError("Email or password is incorrect.");
      } else {
        setFormError(describeAccountError(err, "log in"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Log in to Underwatch"
      subtitle="Use the local account you created on this server."
      footer={
        <>
          No account yet? <Link to="/signup">Sign up</Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-label="Log in">
        {formError ? <AuthFormError>{formError}</AuthFormError> : null}
        <AuthField label="Email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <AuthField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={submitting} loadingText="Logging in…">
          Log in
        </Button>
        <p className="text-center text-[12px] text-text-secondary">
          Have the local access token instead? Open the link from <span className="font-mono">pnpm open</span>.
        </p>
      </form>
    </AuthLayout>
  );
}
