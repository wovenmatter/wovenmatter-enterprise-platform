import { ArrowLeft, ArrowLeftRight, PanelLeftClose, PanelRightClose } from "lucide-react";
import { Icon } from "../components/controls";
import { focusSidebarControl, useSidebar } from "./sidebar-preferences";

export function SidebarControls({ page, onBack, placement = "trailing" }: { page: "navigation" | "content"; onBack?: () => void; placement?: "leading" | "trailing" }) {
  const { preferences, update, contentsSelected, pagedAdaptive, drawer, setDrawer } = useSidebar();
  const split = preferences.style === "split";
  const side = split ? page === "navigation" ? "left" : "right" : preferences.side;
  const adaptiveExpanded = preferences.style === "adaptive" && contentsSelected && !pagedAdaptive;
  const canMove = !split && (page === "navigation" || preferences.style === "single");
  const canCollapse = page === "content" || !adaptiveExpanded;
  const collapseLeading = page === "content" && (split || adaptiveExpanded && side === "right");
  function collapse() {
    if (drawer) { setDrawer(null); return; }
    update(split ? page === "navigation" ? { navigationVisible: false } : { contentVisible: false } : { singleVisible: false });
    focusSidebarControl(`[data-sidebar-reveal="${split ? page : "single"}"]`);
  }
  return <span className="sidebar-controls">
    {canCollapse && collapseLeading && placement === "leading" ? <button type="button" className="icon-button sidebar-collapse" data-sidebar-hide={page} aria-label={split ? "Hide workspace sidebar" : "Hide navigation sidebar"} title="Hide sidebar" onClick={collapse}><Icon icon={side === "left" ? PanelLeftClose : PanelRightClose} size={18} /></button> : null}
    {onBack && !split && placement === "leading" ? <button type="button" className="icon-button sidebar-back" aria-label="Back to workspace navigation" title="Back to workspace navigation" onClick={onBack}><Icon icon={ArrowLeft} size={16} weight="control" /></button> : null}
    {canMove && placement === "trailing" ? <button type="button" className="icon-button sidebar-move" aria-label={`Move sidebar ${side === "left" ? "right" : "left"}`} title={`Move sidebar ${side === "left" ? "right" : "left"}`} onClick={() => update({ side: side === "left" ? "right" : "left", singleVisible: true })}><Icon icon={ArrowLeftRight} size={16} weight="control" /></button> : null}
    {canCollapse && !collapseLeading && placement === "trailing" ? <button type="button" className="icon-button sidebar-collapse" data-sidebar-hide={page} aria-label="Hide navigation sidebar" title="Hide sidebar" onClick={collapse}><Icon icon={side === "left" ? PanelLeftClose : PanelRightClose} size={18} /></button> : null}
  </span>;
}
