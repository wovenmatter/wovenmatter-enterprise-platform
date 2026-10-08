import { useCallback, useEffect, useRef, useState } from "react";
import { coalescedReader } from "./conversation-state";

let csrfToken: string | null = null;
export function setCsrf(token: string | null) {
  csrfToken = token;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("content-type", "application/json");
  if (csrfToken && options.method && options.method !== "GET")
    headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const body =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      body?.error?.message ?? `Request failed (${response.status}).`,
      response.status,
      body?.error?.code ?? "request_failed",
    );
  }
  return body as T;
}
export function send<T>(path: string, body: unknown, method = "POST") {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
export function useResource<T>(path: string | null, pollMs = 0) {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error: string;
    loading: boolean;
  }>({ path: null, error: "", loading: Boolean(path) });
  const trigger = useRef<() => void>(() => {});
  const reload = useCallback(() => trigger.current(), []);
  useEffect(() => {
    if (!path) {
      setState({ path: null, error: "", loading: false });
      trigger.current = () => {};
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    const reader = coalescedReader(async () => {
      setState((previous) => ({
        path,
        data: previous.path === path ? previous.data : undefined,
        error: "",
        loading: true,
      }));
      try {
        const data = await api<T>(path!, { signal: controller.signal });
        if (!disposed) setState({ path, data, error: "", loading: false });
      } catch (error) {
        if (!disposed)
          setState((previous) => ({
            ...previous,
            data:
              error instanceof ApiError &&
              [401, 403, 404].includes(error.status)
                ? undefined
                : previous.data,
            error: errorMessage(error),
            loading: false,
          }));
      }
    });
    trigger.current = reader.trigger;
    reader.trigger();
    return () => {
      disposed = true;
      reader.dispose();
      controller.abort();
      trigger.current = () => {};
    };
  }, [path]);
  useEffect(() => {
    if (!pollMs || !path) return;
    const timer = window.setInterval(reload, pollMs);
    return () => clearInterval(timer);
  }, [path, pollMs, reload]);
  return {
    data: state.path === path ? state.data : undefined,
    error: state.path === path ? state.error : "",
    loading: state.loading || state.path !== path,
    reload,
  };
}
export type User = {
  id: string;
  orgId: string | null;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  enabled: boolean;
  theme: "green" | "cognac";
  defaultModel?: string | null;
  invitationPending?: boolean;
  libraryAccess?: "read" | "write";
};
export type Organization = {
  id: string;
  name: string;
  createdAt: string;
  role: "admin" | "member";
  libraryAccess: "read" | "write";
  defaultHostId: string;
};
export type Project = {
  hostId: string;
  id: string;
  orgId: string;
  name: string;
  description: string;
  access: "read" | "write";
  status: string;
  createdAt: string;
};
export type List<T> = { items: T[] };
export const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
