import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import { Icon } from "../components/controls";
import { useSidebar } from "./sidebar-preferences";

export function SidebarControls({ page, onBack, placement = "trailing" }: { page: "navigation" | "content"; onBack?: () => void; placement?: "leading" | "trailing" }) {
  const { preferences, update, contentsSelected, pagedAdaptive } = useSidebar();
  const split = preferences.style === "split";
  const side = split ? page === "navigation" ? "left" : "right" : preferences.side;
  const adaptiveExpanded = preferences.style === "adaptive" && contentsSelected && !pagedAdaptive;
  const canMove = !split && (page === "navigation" || preferences.style === "single" || pagedAdaptive);
  const canCollapse = page === "content" || !adaptiveExpanded;
  const collapseLeading = side === "right";
  return <span className="sidebar-controls">
    {canCollapse && collapseLeading && placement === "leading" ? <span className="sidebar-toggle-space" aria-hidden="true" /> : null}
    {onBack && !split && placement === "leading" ? <button type="button" className="icon-button sidebar-back" aria-label="Back to workspace navigation" title="Back to workspace navigation" onClick={onBack}><Icon icon={ArrowLeft} size={16} weight="control" /></button> : null}
    {canMove && placement === "trailing" ? <button type="button" className="icon-button sidebar-move" aria-label={`Move sidebar ${side === "left" ? "right" : "left"}`} title={`Move sidebar ${side === "left" ? "right" : "left"}`} onClick={() => update({ side: side === "left" ? "right" : "left", singleVisible: true })}><Icon icon={ArrowLeftRight} size={16} weight="control" /></button> : null}
    {canCollapse && !collapseLeading && placement === "trailing" ? <span className="sidebar-toggle-space" aria-hidden="true" /> : null}
  </span>;
}
