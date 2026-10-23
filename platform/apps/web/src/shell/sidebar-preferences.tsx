import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

// Enterprise intentionally defaults to Adaptive (desktop defaults to Split).
// Existing valid account/browser selections keep their version-1 storage key.
export const sidebarStyles = [
  { value: "adaptive", title: "Adaptive Sidebar", detail: "Keep navigation visible and open folder contents beside it." },
  { value: "single", title: "Single Sidebar", detail: "Open folder contents in place of the movable navigation sidebar." },
  { value: "split", title: "Split Sidebar", detail: "Keep navigation and workspace sidebars visible on opposite sides." },
] as const;
export type SidebarStyle = typeof sidebarStyles[number]["value"];
export type SidebarSide = "left" | "right";
type Preferences = {
  version: 1;
  style: SidebarStyle;
  side: SidebarSide;
  navigationVisible: boolean;
  contentVisible: boolean;
  singleVisible: boolean;
};
const defaults: Preferences = { version: 1, style: "adaptive", side: "left", navigationVisible: true, contentVisible: true, singleVisible: true };
export const sidebarStorageKey = (userId: string) => `wme:sidebar:v1:${userId}`;
function readPreferences(key: string): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value?.version !== 1) return defaults;
    return {
      version: 1,
      style: sidebarStyles.some(style => style.value === value.style) ? value.style : defaults.style,
      side: value.side === "right" ? "right" : "left",
      navigationVisible: typeof value.navigationVisible === "boolean" ? value.navigationVisible : true,
      contentVisible: typeof value.contentVisible === "boolean" ? value.contentVisible : true,
      singleVisible: typeof value.singleVisible === "boolean" ? value.singleVisible : true,
    };
  } catch { return defaults; }
}

const subscribeWidth = (changed: () => void) => {
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
};
type SidebarContextValue = {
  preferences: Preferences;
  update: (changes: Partial<Omit<Preferences, "version">>) => void;
  storageError: boolean;
  narrow: boolean;
  compact: boolean;
  drawerWidth: number;
  pagedAdaptive: boolean;
  workspaceBase: string | undefined;
  workspaceSearch: string;
  contentState: { search: string; tab: "chats" | "notes" };
  updateContentState: (changes: Partial<{ search: string; tab: "chats" | "notes" }>) => void;
  contentsSelected: boolean;
  selectFolder: () => void;
  showNavigation: () => void;
  contentTarget: HTMLDivElement | null;
  setContentTarget: (target: HTMLDivElement | null) => void;
  drawer: "navigation" | "content" | null;
  setDrawer: (drawer: "navigation" | "content" | null) => void;
  drawerOpener: { current: HTMLElement | null };
  rememberChatTrigger: (element: HTMLElement) => void;
};
const SidebarContext = createContext<SidebarContextValue | null>(null);
export function SidebarProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const key = sidebarStorageKey(userId);
  const [preferences, setPreferences] = useState(() => readPreferences(key));
  const [storageError, setStorageError] = useState(false);
  const [contentTarget, setContentTarget] = useState<HTMLDivElement | null>(null);
  const [drawer, setDrawer] = useState<"navigation" | "content" | null>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const chatTrigger = useRef<{ element: HTMLElement; conversation: string | null } | null>(null);
  const location = useLocation();
  const workspaceBase = location.pathname.match(/^\/organizations\/[^/]+\/workspaces\/[^/]+/)?.[0];
  const queries = useRef<Record<string, string>>({});
  if (workspaceBase && (location.pathname === workspaceBase || queries.current[workspaceBase] === undefined)) queries.current[workspaceBase] = location.search;
  const [contentStates, setContentStates] = useState<Record<string, { search: string; tab: "chats" | "notes" }>>({});
  const contentState = workspaceBase ? contentStates[workspaceBase] ?? { search: "", tab: "chats" as const } : { search: "", tab: "chats" as const };
  const [selection, setSelection] = useState<{ workspace: string | undefined; contents: boolean }>({ workspace: workspaceBase, contents: new URLSearchParams(location.search).has("folder") });
  const contentsSelected = selection.workspace === workspaceBase ? selection.contents : new URLSearchParams(location.search).has("folder");
  const width = useSyncExternalStore(subscribeWidth, () => window.innerWidth);
  const narrow = width <= 760; // Organization-only navigation retains its menu.
  const compact = width < 904;
  const drawerWidth = Math.min(width * .82, 320);
  // Native Adaptive has two adjacent drawer pages. Only page them when their
  // combined native width would exceed this browser viewport (e.g. 390px).
  const pagedAdaptive = compact && 2 * drawerWidth > width;
  const creatingChat = location.pathname === workspaceBase && new URLSearchParams(location.search).get("new") === "1";
  const wasCreatingChat = useRef(creatingChat);
  useEffect(() => {
    if (wasCreatingChat.current && !creatingChat && chatTrigger.current) {
      const trigger = chatTrigger.current;
      chatTrigger.current = null;
      requestAnimationFrame(() => {
        if (document.querySelector("dialog[open]")) return;
        if (new URLSearchParams(location.search).get("conversation") !== trigger.conversation) document.querySelector<HTMLElement>('.composer-area textarea')?.focus({ preventScroll: true });
        else if (trigger.element.checkVisibility() && !trigger.element.closest("[inert]")) trigger.element.focus({ preventScroll: true });
        else {
          const fallback = Array.from(document.querySelectorAll<HTMLElement>('.workspace-detail-actions a, .workspace-reveal-controls button, .mobile-menu')).find(element => element.checkVisibility() && !element.closest("[inert]"));
          fallback?.focus({ preventScroll: true });
        }
      });
    }
    wasCreatingChat.current = creatingChat;
  }, [creatingChat, location.search]);
  function update(changes: Partial<Omit<Preferences, "version">>) {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    try { localStorage.setItem(key, JSON.stringify(next)); setStorageError(false); }
    catch { setStorageError(true); }
    if (changes.style) setDrawer(null);
  }
  return <SidebarContext.Provider value={{
    preferences, update, storageError, narrow, compact, drawerWidth, pagedAdaptive, workspaceBase,
    workspaceSearch: workspaceBase ? queries.current[workspaceBase] ?? "" : "",
    contentState,
    updateContentState: changes => {
      if (workspaceBase) setContentStates(previous => ({ ...previous, [workspaceBase]: { ...(previous[workspaceBase] ?? { search: "", tab: "chats" }), ...changes } }));
    },
    contentsSelected,
    selectFolder: () => {
      setSelection({ workspace: workspaceBase, contents: true });
      if (preferences.style !== "split") {
        update({ singleVisible: true });
        if (compact) setDrawer("content");
      } else if (compact) setDrawer(null);
    },
    showNavigation: () => {
      setSelection({ workspace: workspaceBase, contents: false });
      if (compact) setDrawer("navigation");
    },
    contentTarget, setContentTarget, drawer, setDrawer, drawerOpener,
    rememberChatTrigger: element => { chatTrigger.current = { element, conversation: new URLSearchParams(queries.current[workspaceBase ?? ""] ?? "").get("conversation") }; },
  }}>{children}</SidebarContext.Provider>;
}
export function useSidebar() {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("SidebarProvider is required");
  return value;
}

export function focusSidebarControl(selector: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }));
}
