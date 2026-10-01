import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, send, setCsrf } from "./api";
import { safeContentUrl } from "./conversation-state";
import { ErrorNotice, Loading } from "./components/ui";
import { AuthPage, type Session } from "./features/auth";
import { Shell } from "./shell/Shell";

export function App() {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState("");
  const location = useLocation();
  useEffect(() => {
    let active = true;
    api<Session>("/enterprise/api/session")
      .then((s) => {
        if (active) {
          setCsrf(s.csrfToken);
          document.documentElement.dataset.theme = s.user?.theme ?? "green";
          setSession(s);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const expire = () => {
      setCsrf(null);
      setSession({ user: null, csrfToken: null });
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  function authenticated(s: Session) {
    setCsrf(s.csrfToken);
    document.documentElement.dataset.theme = s.user?.theme ?? "green";
    setSession(s);
    const target = new URLSearchParams(window.location.search).get("returnTo");
    if (target?.startsWith("/enterprise/") && safeContentUrl(target))
      window.location.assign(target);
  }
  if (error)
    return (
      <main className="auth-page">
        <ErrorNotice message={error} />
        <button onClick={() => window.location.reload()}>Retry</button>
      </main>
    );
  if (!session) return <Loading />;
  if (
    !session.user ||
    location.pathname === "/activate" ||
    location.pathname === "/forgot-password" ||
    location.pathname === "/reset-password"
  )
    return <AuthPage onSuccess={authenticated} />;
  return (
    <Shell
      user={session.user}
      onUserChange={(user) => {
        document.documentElement.dataset.theme = user.theme;
        setSession((s) => (s ? { ...s, user } : s));
      }}
      logout={async () => {
        await send("/enterprise/api/logout", {});
        setCsrf(null);
        setSession({ user: null, csrfToken: null });
      }}
    />
  );
}
