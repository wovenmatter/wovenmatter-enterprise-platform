import { Link, Navigate } from "react-router-dom";
import { Folder, Plus } from "lucide-react";
import type { Organization, User } from "../api";
import { Empty, PageHeader } from "../components/ui";

export function AdministrationPage({
  user,
  organizations,
  onCreate,
}: {
  user: User;
  organizations: Organization[];
  onCreate: () => void;
}) {
  if (user.role !== "owner" && organizations.length === 1)
    return <Navigate to={`/organizations/${organizations[0]!.id}/projects`} replace />;
  return (
    <section>
      <PageHeader
        title={user.role === "owner" ? "Administration" : "Your access"}
        description={
          user.role === "owner"
            ? "Manage every organization on the platform."
            : "Open an organization you are authorized to use."
        }
        actions={
          user.role === "owner" ? (
            <button className="primary" onClick={onCreate}>
              <Plus size={17} />
              Create organization
            </button>
          ) : null
        }
      />
      {organizations.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((org) => (
                <tr key={org.id}>
                  <td>
                    <Link className="item-link" to={`/organizations/${org.id}/projects`}>
                      <Folder size={20} />
                      <strong>{org.name}</strong>
                    </Link>
                  </td>
                  <td>{new Date(org.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={
            user.role === "owner"
              ? "No organizations yet"
              : "No organization access"
          }
          action={
            user.role === "owner" ? (
              <button className="primary" onClick={onCreate}>
                Create organization
              </button>
            ) : undefined
          }
        >
          {user.role === "owner"
            ? "Create an organization to begin."
            : "Ask an administrator to grant access."}
        </Empty>
      )}
    </section>
  );
}
