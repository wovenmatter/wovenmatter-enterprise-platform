import { createContext, useContext } from "react";
import type { Organization, User } from "./api";

type Workspace = {
  user: User;
  org: Organization;
  isAdmin: boolean;
  refreshOrganizations: () => void;
  selectOrganization: (orgId: string) => void;
  orgBase: string;
};
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("Organization context missing");
  return ctx;
}
