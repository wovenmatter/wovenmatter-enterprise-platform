import { useEffect } from "react";
// Refresh the persistent rail after mutations without remounting the shell.
export function workspaceChanged() {
  window.dispatchEvent(new Event("workspace-changed"));
}
export function useWorkspaceChanges(reload: () => void) {
  useEffect(() => {
    window.addEventListener("workspace-changed", reload);
    return () => window.removeEventListener("workspace-changed", reload);
  }, [reload]);
}
export function readWorkspaceValue(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeWorkspaceValue(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* Navigation still works without storage. */
  }
}
