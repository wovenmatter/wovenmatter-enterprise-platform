import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AriaAttributes,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Check,
  ChevronDown,
  Ellipsis,
  Search,
  type LucideIcon,
} from "lucide-react";

// WovenMatter DashboardStyle.swift glyph roles: normal 1.5, controls 1.75,
// search/filter/alert 2, send arrows 2.5. Glyphs are decorative; controls
// carry the accessible name.
const strokes = { normal: 1.5, control: 1.75, search: 2, send: 2.5 } as const;
export type IconWeight = keyof typeof strokes;
export function Icon({
  icon: Glyph,
  size = 16,
  weight = "normal",
  className,
}: {
  icon: LucideIcon;
  size?: number;
  weight?: IconWeight;
  className?: string;
}) {
  return (
    <Glyph
      size={size}
      strokeWidth={strokes[weight]}
      className={className}
      aria-hidden="true"
      focusable="false"
    />
  );
}

/** Trailing sidebar disclosure chevron: right when closed, down when open. */
export function DisclosureChevron({ size = 12 }: { size?: number }) {
  return (
    <Icon
      icon={ChevronDown}
      size={size}
      weight="control"
      className="disclosure-chevron"
    />
  );
}

// One app popup is open at a time, matching native menus and popovers.
let activePopup: { close(): void } | null = null;
const margin = 8;
function place(anchor: DOMRect, node: HTMLElement, align: "start" | "end") {
  const width = node.offsetWidth,
    height = node.offsetHeight,
    viewWidth = document.documentElement.clientWidth,
    viewHeight = window.innerHeight;
  let top = anchor.bottom + 4;
  if (top + height > viewHeight - margin) {
    const above = anchor.top - 4 - height;
    top = above >= margin ? above : Math.max(margin, viewHeight - margin - height);
  }
  let left = align === "end" ? anchor.right - width : anchor.left;
  left = Math.min(Math.max(margin, left), Math.max(margin, viewWidth - margin - width));
  return { top, left };
}
type Focus = "selected" | "first" | "last";
export function usePopup<T extends HTMLElement = HTMLButtonElement>(
  align: "start" | "end",
  anchorRef?: RefObject<T | null>,
) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const defaultTrigger = useRef<T>(null);
  const trigger = anchorRef ?? defaultTrigger;
  const [pointerOffset, setPointerOffset] = useState<{ x: number; y: number } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<Focus>("selected");
  const entry = useRef({ close: () => setOpen(false) });
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, [trigger]);
  const show = useCallback((focus: Focus, point?: { x: number; y: number }) => {
    initialFocus.current = focus;
    const bounds = trigger.current?.getBoundingClientRect();
    setPointerOffset(point && bounds ? { x: point.x - bounds.left, y: point.y - bounds.top } : null);
    setStyle({ visibility: "hidden" });
    setOpen(true);
  }, [trigger]);
  useLayoutEffect(() => {
    const node = popup.current;
    if (!open || !node) return;
    // The top layer keeps menus above dialogs and outside clipped rails.
    if (typeof node.showPopover === "function" && !node.matches(":popover-open"))
      node.showPopover();
    if (activePopup && activePopup !== entry.current) activePopup.close();
    activePopup = entry.current;
    let frame = 0;
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor || anchor.bottom < 0 || anchor.top > window.innerHeight) {
        close(false);
        return;
      }
      const position = place(pointerOffset
        ? new DOMRect(anchor.left + pointerOffset.x, anchor.top + pointerOffset.y, 0, 0)
        : anchor, node, align);
      // Position before focusing: hidden elements cannot take focus.
      node.style.top = `${position.top}px`;
      node.style.left = `${position.left}px`;
      node.style.visibility = "visible";
      setStyle(position);
    };
    update();
    const items = focusable(node);
    const selected =
      initialFocus.current === "selected"
        ? items.find((item) => item.getAttribute("aria-selected") === "true")
        : undefined;
    const emptyTarget = () => node.querySelector<HTMLElement>('[role="listbox"]') ?? node;
    focusPopupItem(
      node,
      selected ?? (initialFocus.current === "last" ? items.at(-1) : items[0]) ?? emptyTarget(),
    );
    let focused = document.activeElement as HTMLElement;
    let focusedIndex = items.indexOf(focused);
    const rememberFocus = () => {
      focused = document.activeElement as HTMLElement;
      focusedIndex = focusable(node).indexOf(focused);
    };
    // Canonical updates can disable or remove the focused action. Browsers
    // then drop focus to body, outside this popup's keyboard handlers. Recover
    // to an enabled neighbor (or the empty popup) without stealing focus from
    // another control or a newly opened dialog.
    const changes = new MutationObserver(() => {
      const enabled = focusable(node);
      const current = document.activeElement;
      if (
        focused !== node &&
        !enabled.includes(focused) &&
        (current === document.body || current === focused || node.contains(current))
      ) {
        focusPopupItem(
          node,
          enabled[Math.max(0, Math.min(focusedIndex, enabled.length - 1))] ?? emptyTarget(),
        );
      }
    });
    node.addEventListener("focusin", rememberFocus);
    changes.observe(node, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
    });
    const outside = (event: PointerEvent) => {
      const element = event.target as Node;
      if (!node.contains(element) && !trigger.current?.contains(element))
        close(false);
    };
    const reposition = (event: Event) => {
      if (event.target instanceof Node && node.contains(event.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    // Catalog polling and asynchronous menu content can change the popup's
    // dimensions without a window resize. Keep the top-layer surface in view.
    const size = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    size.observe(node);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      changes.disconnect();
      size.disconnect();
      node.removeEventListener("focusin", rememberFocus);
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      if (activePopup === entry.current) activePopup = null;
    };
  }, [open, align, close, trigger, pointerOffset]);
  function keys(event: KeyboardEvent<HTMLDivElement>, choose?: () => void) {
    const node = popup.current;
    if (!node) return;
    const items = focusable(node);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      const target = items[(next + items.length) % items.length];
      if (target) focusPopupItem(node, target);
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      // Keep Escape from also closing an enclosing dialog or drawer.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if ((event.key === "Enter" || event.key === " ") && choose) {
      event.preventDefault();
      choose();
    }
  }
  function triggerKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show(event.key === "ArrowUp" ? "last" : "first");
    }
  }
  return { open, show, close, style, trigger, popup, keys, triggerKeys };
}
function focusPopupItem(node: HTMLElement, item: HTMLElement) {
  item.focus({ preventScroll: true });
  // Reveal the choice through both popup scrollers on short windows, stopping
  // at the popup so the conversation and page stay in place.
  const list = item.closest<HTMLElement>(".picker-list");
  for (const viewport of list && list !== node ? [list, node] : [node]) {
    const bounds = viewport.getBoundingClientRect(), choice = item.getBoundingClientRect();
    const top = bounds.top + viewport.clientTop, bottom = top + viewport.clientHeight;
    if (choice.top < top) viewport.scrollTop += Math.floor(choice.top - top);
    else if (choice.bottom > bottom) viewport.scrollTop += Math.ceil(choice.bottom - bottom);
  }
}
function focusable(node: HTMLElement) {
  return Array.from(
    node.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled),[role="option"]:not([aria-disabled="true"]),[role="switch"]:not(:disabled)',
    ),
  );
}

const MenuContext = createContext<(restoreFocus: boolean) => void>(() => {});
/**
 * Compact action menu: a quiet icon trigger and a top-layer popup. Escape,
 * Tab and outside clicks close it; keyboard dismissal returns focus to the
 * trigger. Disabled actions stay visible and inert.
 */
export function Menu({
  label,
  children,
  icon = Ellipsis,
  iconSize = 16,
  iconWeight = "control",
  className = "",
  align = "end",
  triggerText,
  disabled,
}: {
  label: string;
  triggerText?: string;
  children: ReactNode;
  icon?: LucideIcon;
  iconSize?: number;
  iconWeight?: IconWeight;
  className?: string;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const popup = usePopup(align);
  const close = popup.close;
  useLayoutEffect(() => {
    if (disabled && popup.open) close(true);
  }, [disabled, popup.open, close]);
  const id = useId();
  return (
    <>
      <button
        ref={popup.trigger}
        type="button"
        disabled={disabled}
        className={`icon-button menu-trigger ${className}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={popup.open}
        aria-controls={popup.open ? id : undefined}
        onClick={() => (popup.open ? popup.close(false) : popup.show("first"))}
        onKeyDown={popup.triggerKeys}
      >
        <Icon icon={icon} size={iconSize} weight={iconWeight} />
        {triggerText ? <span>{triggerText}</span> : null}
      </button>
      {popup.open ? (
        <div
          ref={popup.popup}
          id={id}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          popover="manual"
          className="popup menu"
          style={popup.style}
          onKeyDown={(event) => popup.keys(event)}
        >
          <MenuContext.Provider value={popup.close}>
            {children}
          </MenuContext.Provider>
        </div>
      ) : null}
    </>
  );
}

/** A row's actions, opened at the pointer or from its existing focusable link. */
export function ContextMenu({ label, trigger, actions, children, onOpen }: {
  label: string;
  trigger: RefObject<HTMLAnchorElement | null>;
  actions: ReactNode;
  children: (attributes: AriaAttributes) => ReactNode;
  onOpen: () => void;
}) {
  const popup = usePopup("start", trigger);
  const id = useId();
  return <>
    <div className="rail-row"
      onClick={() => popup.close(false)}
      onContextMenu={event => {
        if (!actions) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
        popup.show("first", { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={event => {
        if (!actions || event.target !== trigger.current ||
          !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
        popup.show("first");
      }}>
      {children(actions ? {
        "aria-haspopup": "menu",
        "aria-expanded": popup.open,
        "aria-controls": popup.open ? id : undefined,
        "aria-keyshortcuts": "Shift+F10",
      } : {})}
    </div>
    {popup.open ? <div ref={popup.popup} id={id} role="menu" tabIndex={-1}
      aria-label={label} popover="manual" className="popup menu" style={popup.style}
      onKeyDown={event => popup.keys(event)}>
      <MenuContext.Provider value={popup.close}>{actions}</MenuContext.Provider>
    </div> : null}
  </>;
}
export function MenuItem({
  children,
  onSelect,
  disabled,
  danger,
  icon,
  title,
}: {
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon?: LucideIcon;
  title?: string;
}) {
  const close = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${danger ? " danger" : ""}`}
      disabled={disabled}
      title={title}
      onClick={() => {
        close(true);
        onSelect();
      }}
    >
      {icon ? <Icon icon={icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}
export function MenuLink({
  href,
  children,
  download,
}: {
  href: string;
  children: ReactNode;
  download?: boolean;
}) {
  const close = useContext(MenuContext);
  return (
    <a
      role="menuitem"
      className="menu-item"
      href={href}
      download={download}
      onClick={() => close(true)}
    >
      <span>{children}</span>
    </a>
  );
}
export function MenuSeparator() {
  return <div role="separator" className="menu-separator" />;
}

/** Calendar category palette, using the same focus/positioning as other pickers. */
export function ColorPicker({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string; color: string }[];
  onChange: (value: string) => void;
}) {
  const popup = usePopup("start");
  const id = useId();
  const current = options.find(option => option.value === value) ?? options[0];
  function choose(value: string) {
    onChange(value);
    popup.close(true);
  }
  return <>
    <button ref={popup.trigger} type="button" className="calendar-color-trigger"
      aria-label={`${label} color: ${current.label}`} title={`Change the color for ${label.toLowerCase()}`}
      aria-haspopup="listbox" aria-expanded={popup.open} aria-controls={popup.open ? id : undefined}
      onClick={() => popup.open ? popup.close(false) : popup.show("selected")} onKeyDown={popup.triggerKeys}>
      <i aria-hidden="true" style={{ backgroundColor: current.color }} />
      <span>{label}</span><Icon icon={ChevronDown} size={10} weight="control" />
    </button>
    {popup.open ? <div ref={popup.popup} popover="manual" tabIndex={-1} className="popup calendar-color-picker" style={popup.style}
      onKeyDown={event => popup.keys(event, () => {
        const value = document.activeElement?.getAttribute("data-value");
        if (value && options.some(option => option.value === value)) choose(value);
      })}>
      <div className="calendar-color-heading" id={`${id}-heading`}>{label}</div>
      <div role="listbox" id={id} aria-labelledby={`${id}-heading`} className="calendar-color-options">
        {options.map(option => <div key={option.value} role="option" tabIndex={-1} aria-selected={value === option.value}
          data-value={option.value} className="calendar-color-option" onClick={() => choose(option.value)}>
          <i aria-hidden="true" style={{ backgroundColor: option.color }} /><span>{option.label}</span>
          {value === option.value ? <Icon icon={Check} size={12} /> : null}
        </div>)}
      </div>
    </div> : null}
  </>;
}

export type PickerOption = {
  value: string;
  label: string;
  /** Disambiguation shown only when needed, e.g. a provider. */
  detail?: string;
  description?: string;
  disabled?: boolean;
};
/**
 * WovenMatter composer selector: a full-height trigger with the current
 * choice, and a titled popout listing full labels with a checked selection.
 */
export function Picker({
  label,
  heading,
  icon,
  value,
  options,
  placeholder,
  disabled,
  width = 288,
  emptyMessage,
  title,
  className = "",
  onChange,
}: {
  label: string;
  heading: string;
  title?: string;
  className?: string;
  icon: LucideIcon;
  value: string;
  options: PickerOption[];
  placeholder: string;
  disabled?: boolean;
  width?: number;
  emptyMessage?: string;
  onChange: (value: string) => void;
}) {
  const popup = usePopup("start");
  const close = popup.close;
  useLayoutEffect(() => {
    if (disabled && popup.open) close(true);
  }, [disabled, popup.open, close]);
  const id = useId();
  const current = options.find((option) => option.value === value);
  function choose(option?: PickerOption) {
    if (disabled || !option || option.disabled) return;
    popup.close(true);
    if (option.value !== value) onChange(option.value);
  }
  return (
    <>
      <button
        ref={popup.trigger}
        type="button"
        className={`composer-picker ${className}`}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={popup.open}
        aria-controls={popup.open ? `${id}-list` : undefined}
        aria-labelledby={`${id}-label ${id}-value`}
        title={title ?? (current ? `${heading}: ${current.label}` : heading)}
        // aria-disabled keeps keyboard focus when a pending save disables it.
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          if (popup.open) popup.close(false);
          else popup.show("selected");
        }}
        onKeyDown={(event) => {
          if (!disabled) popup.triggerKeys(event);
        }}
      >
        <span className="sr-only" id={`${id}-label`}>
          {label}
        </span>
        <Icon icon={icon} size={14} weight="control" />
        <span className="composer-picker-value" id={`${id}-value`}>
          {current?.label ?? placeholder}
        </span>
        <Icon icon={ChevronDown} size={14} weight="control" />
      </button>
      {popup.open ? (
        <div
          ref={popup.popup}
          tabIndex={-1}
          popover="manual"
          className="popup picker"
          style={{ ...popup.style, width }}
          onKeyDown={(event) =>
            popup.keys(event, () =>
              choose(
                options.find(
                  (_, index) =>
                    `${id}-option-${index}` === document.activeElement?.id,
                ),
              ),
            )
          }
        >
          <div className="picker-heading" id={`${id}-heading`}>
            {heading}
          </div>
          <div
            role="listbox"
            id={`${id}-list`}
            tabIndex={-1}
            aria-labelledby={`${id}-heading`}
            aria-describedby={!options.length ? `${id}-empty` : undefined}
            className="picker-list"
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              return (
                <div
                  key={`${index}:${option.value}`}
                  id={`${id}-option-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  aria-disabled={disabled || option.disabled || undefined}
                  data-value={option.value}
                  className="picker-option"
                  title={[option.label, option.detail, option.description]
                    .filter(Boolean)
                    .join("\n")}
                  onClick={() => choose(option)}
                >
                  <span className="picker-option-text">
                    <span>{option.label}</span>
                    {option.detail ? <small>{option.detail}</small> : null}
                    {option.description ? (
                      <small className="picker-option-description">
                        {option.description}
                      </small>
                    ) : null}
                  </span>
                  {selected ? (
                    <Icon icon={Check} size={14} weight="control" />
                  ) : null}
                </div>
              );
            })}
          </div>
          {!options.length ? (
            <p id={`${id}-empty`} className="picker-empty">{emptyMessage}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** DashboardSwitchToggleStyle: 28 × 16 switch before its label. */
export function Switch({
  children,
  ...input
}: {
  children: ReactNode;
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" {...input} />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-label">{children}</span>
    </label>
  );
}

/** DashboardSearchField: 34-point whisper field with Clear when populated. */
export function SearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="search-field">
      <Icon icon={Search} size={14} weight="search" />
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Escape clears a populated search; an empty one lets the drawer close.
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
