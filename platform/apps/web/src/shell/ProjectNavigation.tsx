import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Files,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { useResource, type List, type Project, type User } from "../api";
import type { Conversation } from "../api";
import { ErrorNotice } from "../components/ui";
import {
  readWorkspaceValue,
  writeWorkspaceValue,
  useWorkspaceChanges,
} from "../workspace-events";

export function ProjectNavigation({
  orgId,
  user,
  isAdmin,
}: {
  orgId: string;
  user: User;
  isAdmin: boolean;
}) {
  const projects = useResource<List<Project>>(
    `/enterprise/api/organizations/${orgId}/projects`,
    10000,
  );
  useWorkspaceChanges(projects.reload);
  const location = useLocation();
  const activeProject = location.pathname.match(/\/projects\/([^/]+)/)?.[1];
  const [search, setSearch] = useState("");
  const base = `/organizations/${orgId}`;
  const currentConversation = new URLSearchParams(location.search).get(
    "conversation",
  );
  return (
    <div className="project-navigation">
      {activeProject ? (
        <Link
          className="nav-link new-conversation"
          to={`${base}/projects/${activeProject}?${new URLSearchParams({ ...(currentConversation ? { conversation: currentConversation } : {}), new: "1" })}`}
        >
          <Plus size={18} />
          New conversation
        </Link>
      ) : null}
      <label className="rail-search">
        <Search size={16} />
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search conversations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="rail-section-heading">
        <NavLink end className="text-button" to={`${base}/projects`}>
          Projects
        </NavLink>
        {isAdmin ? (
          <Link
            className="icon-button"
            aria-label="New project"
            title="New project"
            to={`${base}/projects?new=1`}
          >
            <Plus size={16} />
          </Link>
        ) : null}
      </div>
      <ErrorNotice message={projects.error} />
      {projects.data?.items.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          userId={user.id}
          isAdmin={isAdmin}
          current={activeProject === project.id}
          search={search}
        />
      ))}
      {!projects.loading && !projects.data?.items.length ? (
        <p className="rail-empty">No projects yet.</p>
      ) : null}
    </div>
  );
}
function ProjectRow({
  project,
  userId,
  isAdmin,
  current,
  search,
}: {
  project: Project;
  userId: string;
  isAdmin: boolean;
  current: boolean;
  search: string;
}) {
  const key = `wme:expanded:${userId}:${project.id}`;
  const [expanded, setExpanded] = useState(
    () => current || readWorkspaceValue(key) === "true",
  );
  useEffect(() => {
    if (current) {
      setExpanded(true);
      writeWorkspaceValue(key, "true");
    }
  }, [current, key]);
  const conversations = useResource<List<Conversation>>(
    expanded || search
      ? `/enterprise/api/projects/${project.id}/conversations`
      : null,
    expanded ? 10000 : 0,
  );
  useWorkspaceChanges(conversations.reload);
  const location = useLocation();
  const selected =
    current && !/\/(files|members|settings)$/.test(location.pathname)
      ? new URLSearchParams(location.search).get("conversation")
      : null;
  const base = `/organizations/${project.orgId}/projects/${project.id}`;
  const matching =
    conversations.data?.items.filter((c) =>
      c.title.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <div className="rail-project">
      <button
        className="nav-link project-disclosure"
        aria-expanded={expanded}
        title={project.name}
        onClick={() => {
          setExpanded(!expanded);
          writeWorkspaceValue(key, String(!expanded));
        }}
      >
        <ChevronRight className={expanded ? "expanded" : ""} size={14} />
        {expanded ? <FolderOpen size={17} /> : <Folder size={17} />}
        <span>{project.name}</span>
      </button>
      {expanded || search ? (
        <div className="project-children">
          {current && !search ? (
            <nav aria-label="Project navigation">
              <Link className="nav-link project-tool" to={base}>
                <MessageSquare size={15} />
                Conversations
              </Link>
              <NavLink
                className={({ isActive }) =>
                  `nav-link project-tool ${isActive ? "active" : ""}`
                }
                to={`${base}/files`}
              >
                <Files size={15} />
                Files
              </NavLink>
              <NavLink
                className={({ isActive }) =>
                  `nav-link project-tool ${isActive ? "active" : ""}`
                }
                to={`${base}/members`}
              >
                <Users size={15} />
                Members
              </NavLink>
              {isAdmin ? (
                <NavLink
                  className={({ isActive }) =>
                    `nav-link project-tool ${isActive ? "active" : ""}`
                  }
                  to={`${base}/settings`}
                >
                  <Settings size={15} />
                  Project settings
                </NavLink>
              ) : null}
            </nav>
          ) : null}
          <ErrorNotice message={conversations.error} />
          <div className="conversation-list">
            {matching.map((c) => (
              <Link
                className={`conversation-link ${selected === c.id ? "selected" : ""}`}
                key={c.id}
                to={`${base}?conversation=${encodeURIComponent(c.id)}`}
                title={c.title}
                aria-current={selected === c.id ? "page" : undefined}
              >
                <MessageSquare size={15} />
                <span>{c.title}</span>
                {c.activeRun ? (
                  <span
                    className="working-dot"
                    title="Working"
                    aria-label="Working"
                  />
                ) : null}
              </Link>
            ))}
            {search && !matching.length && !conversations.loading ? (
              <small className="rail-empty">No matching conversations.</small>
            ) : null}
          </div>
          {!current && !search ? (
            <Link className="nav-link project-tool" to={base}>
              Open project
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
