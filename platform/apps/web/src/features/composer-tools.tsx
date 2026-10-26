import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { errorMessage, send } from "../api";
import { Icon, Switch, usePopup } from "../components/controls";
import { ErrorNotice } from "../components/ui";
import "./composer-tools.css";

const groups = [
  { id: "notes", label: "Notes", description: "Notes, artifacts and managed databases" },
  { id: "history", label: "Conversation history", description: "Read conversations in this workspace" },
  { id: "sessions", label: "Sessions", description: "Coordinate chats with current workspace consent" },
  { id: "timers", label: "Timers", description: "Scheduled instructions for this chat" },
  { id: "browser", label: "Browser", description: "Isolated workspace browser" },
  { id: "executor", label: "Connected apps", description: "Selected organization app profiles only" },
  { id: "usage", label: "Usage data", description: "Read only" },
  { id: "calendar", label: "Calendar", description: "Events and scheduled tasks" },
  { id: "library", label: "Library", description: "Workspace library items" },
] as const;
export type ConversationTools = Record<typeof groups[number]["id"], boolean>;
export const defaultConversationTools: ConversationTools = { notes: true, history: true, sessions:true,timers:true,browser:true,executor:false,usage: true, calendar: true, library: true };

/** DashboardComposer / WorkspaceToolControls, desktop f885d281. */
export function ComposerTools({ conversationId, settings = defaultConversationTools, onChange, onSaved, onSaving, disabled = false }: {
  conversationId?: string;
  settings?: ConversationTools;
  onChange?: (settings: ConversationTools) => void;
  onSaved?: () => void;
  onSaving?: (saving: boolean) => void;
  disabled?: boolean;
}) {
  const popup = usePopup("start"), id = useId();
  const [confirmed, setConfirmed] = useState(settings), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const savedFocus = useRef<keyof ConversationTools | null>(null);
  const signature = JSON.stringify(settings);
  useEffect(() => { setConfirmed(JSON.parse(signature)); }, [signature, conversationId]);
  const close = popup.close;
  useEffect(() => { if (disabled && !saving.current && popup.open) close(true); }, [disabled, popup.open, close]);
  useLayoutEffect(() => {
    if (busy || disabled || !popup.open || !savedFocus.current) return;
    const node = popup.popup.current;
    // Disabling every switch during a save moves focus to the popup. Restore
    // the initiating switch only while focus remains inside this popup.
    if (node?.contains(document.activeElement)) node.querySelector<HTMLInputElement>(`input[name="conversation-tool-${savedFocus.current}"]`)?.focus({ preventScroll: true });
    savedFocus.current = null;
  }, [busy, disabled, popup.open, popup.popup]);
  async function change(group: keyof ConversationTools, enabled: boolean) {
    if (disabled || saving.current) return;
    setError("");
    if (!conversationId) {
      const next = { ...confirmed, [group]: enabled };
      setConfirmed(next); onChange?.(next);
      return;
    }
    savedFocus.current = group;
    saving.current = true; setBusy(true); onSaving?.(true);
    try {
      const result = await send<{ settings: ConversationTools }>(`/enterprise/api/conversations/${conversationId}/tools`, { group, enabled }, "PATCH");
      setConfirmed(result.settings); onChange?.(result.settings); onSaved?.();
    } catch (e) { setError(errorMessage(e)); }
    finally { saving.current = false; setBusy(false); onSaving?.(false); }
  }
  return <>
    <button ref={popup.trigger} type="button" className="composer-picker composer-tools-trigger"
      aria-label="Tools" aria-haspopup="dialog" aria-expanded={popup.open} aria-controls={popup.open ? id : undefined}
      disabled={disabled} onClick={() => popup.open ? popup.close(false) : popup.show("first")} onKeyDown={popup.triggerKeys}>
      <span>Tools</span><Icon icon={ChevronDown} size={10} weight="control" />
    </button>
    {popup.open ? <div ref={popup.popup} id={id} role="dialog" aria-label="Conversation tools" tabIndex={-1} popover="manual"
      className="popup composer-tools-popup" style={popup.style} onKeyDown={event => popup.keys(event)}>
      <strong className="composer-tools-heading">Tools</strong>
      <div className="composer-tool-groups">
        {groups.map(group => <div className="composer-tool-group" key={group.id}>
          <Switch name={`conversation-tool-${group.id}`} checked={confirmed[group.id]} disabled={disabled || busy} onChange={event => void change(group.id, event.target.checked)}>{group.label}</Switch>
          <small>{group.description}</small>
        </div>)}
      </div>
      <p className="composer-tools-scope">These switches control workspace tools. Shell access follows workspace permissions. Attached notes and conversations remain available to read.</p>
      {busy ? <small role="status">Saving tool settings…</small> : null}
      <ErrorNotice message={error} />
    </div> : null}
  </>;
}
