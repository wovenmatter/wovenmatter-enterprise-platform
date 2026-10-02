import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { send, type User } from "../api";
import { Brand } from "../components/Brand";
import { AsyncForm, Field, Success } from "../components/ui";

export type Session = { user: User | null; csrfToken: string | null };

export function AuthPage({ onSuccess }: { onSuccess: (s: Session) => void }) {
  const location = useLocation(),
    navigate = useNavigate();
  const activate = location.pathname === "/activate";
  const forgot = location.pathname === "/forgot-password";
  const reset = location.pathname === "/reset-password";
  const token = new URLSearchParams(location.search).get("token");
  const [notice, setNotice] = useState("");
  const title = activate
    ? "Set up your account"
    : forgot
      ? "Reset your password"
      : reset
        ? "Choose a new password"
        : "Welcome back";
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <Brand />
        <h1>{title}</h1>
        <p className="muted">
          {activate
            ? "Choose a password to join your organization."
            : forgot
              ? "Enter your account email and we will send a private reset link."
              : reset
                ? "Use a strong password to finish resetting your account."
                : "Sign in to your workspace."}
        </p>
        {notice ? <Success>{notice}</Success> : null}
        <AsyncForm
          submitLabel={
            activate
              ? "Activate account"
              : forgot
                ? "Send reset link"
                : reset
                  ? "Reset password"
                  : "Sign in"
          }
          onSubmit={async (data) => {
            if (activate && !token)
              throw new Error(
                "This invitation link is missing its token. Ask your administrator for a new invitation.",
              );
            if (reset && !token)
              throw new Error(
                "This password reset link is missing its token. Request a new reset link.",
              );
            if (forgot) {
              const result = await send<{ message: string }>(
                "/enterprise/api/password-reset/request",
                { email: data.get("email") },
              );
              setNotice(result.message);
              return;
            }
            const body = activate
              ? {
                  token,
                  password: data.get("password"),
                  name: data.get("name") || undefined,
                }
              : reset
                ? { token, password: data.get("password") }
                : { email: data.get("email"), password: data.get("password") };
            onSuccess(
              await send<Session>(
                activate
                  ? "/enterprise/api/activate"
                  : reset
                    ? "/enterprise/api/password-reset/confirm"
                    : "/enterprise/api/login",
                body,
              ),
            );
            if (activate || reset) navigate("/", { replace: true });
          }}
        >
          {activate ? (
            <Field label="Your name">
              <input name="name" autoComplete="name" maxLength={160} />
            </Field>
          ) : reset ? null : (
            <Field label="Email">
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
              />
            </Field>
          )}
          {!forgot ? (
            <Field
              label="Password"
              hint={
                activate || reset ? "Use at least 12 characters." : undefined
              }
            >
              <input
                name="password"
                type="password"
                autoComplete={
                  activate || reset ? "new-password" : "current-password"
                }
                minLength={activate || reset ? 12 : undefined}
                required
              />
            </Field>
          ) : null}
        </AsyncForm>
        {!activate && !forgot && !reset ? (
          <p className="auth-footnote">
            Accounts are provided by your organization.{" "}
            <Link to="/forgot-password">Reset password</Link>
          </p>
        ) : (
          <Link to="/login">Back to sign in</Link>
        )}
      </section>
    </main>
  );
}
