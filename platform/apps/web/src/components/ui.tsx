import {
  useEffect,
  useId,
  useRef,
  useState,
  cloneElement,
  isValidElement,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  CircleAlert,
  Check,
  ChevronRight,
  LoaderCircle,
  PanelLeftClose,
  X,
  type LucideIcon,
} from "lucide-react";
import { errorMessage } from "../api";
import { Icon } from "./controls";

export function ErrorNotice({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return message ? (
    <div className="notice error" role="alert">
      <Icon icon={CircleAlert} size={16} weight="search" />
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="text-button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  ) : null;
}
export function Success({ children }: { children: ReactNode }) {
  return (
    <div className="notice success" role="status">
      <Icon icon={Check} size={16} weight="control" />
      <span>{children}</span>
    </div>
  );
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Icon icon={LoaderCircle} size={16} weight="control" className="spin" />
      {label}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {icon ? <div className="page-header-title"><span className="page-header-icon">{icon}</span><h1>{title}</h1></div> : <h1>{title}</h1>}
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
/** WovenMatter SettingsCard: titled 16-point inset group on a theme fill. */
export function Card({
  title,
  detail,
  actions,
  children,
  className = "",
}: {
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={`settings-card ${className}`} aria-labelledby={id}>
      <div className="settings-card-header">
        <div>
          <h2 id={id}>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
/** WovenMatter SettingsDestinationRow: whole-row link with a trailing chevron. */
export function DestinationRow({
  to,
  icon,
  title,
  detail,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  detail?: string;
}) {
  return (
    <Link className="destination-row" to={to}>
      <Icon icon={icon} size={16} />
      <span className="destination-text">
        <strong>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <Icon icon={ChevronRight} size={11} weight="search" className="destination-chevron" />
    </Link>
  );
}
/** WovenMatter SettingsBackButton: quiet 32-point icon, inset −8. */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="icon-button settings-back-link"
      aria-label={label}
      title={label}
    >
      <Icon icon={PanelLeftClose} size={16} weight="control" />
    </Link>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(
        children as ReactElement<{ id?: string; "aria-describedby"?: string }>,
        { id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) },
      )
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " wide" : ""}${compact ? " compact" : ""}`}
      aria-labelledby={id}
      onCancel={(e) => {
        // React propagates a nested confirmation's cancel to its parent
        // dialog; Escape closes only the topmost dialog.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-header">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button small"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon icon={X} size={16} weight="control" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function AsyncForm({
  onSubmit,
  children,
  submitLabel = "Save",
  onCancel,
  className = "",
  danger = false,
}: {
  onSubmit: (data: FormData) => Promise<void>;
  children: ReactNode;
  submitLabel?: string;
  onCancel?: () => void;
  className?: string;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSubmit(data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={`form ${className}`} onSubmit={submit}>
      <fieldset disabled={busy}>{children}</fieldset>
      <ErrorNotice message={error} />
      <div className="form-actions">
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          className={danger ? "destructive" : "primary"}
          disabled={busy}
          type="submit"
        >
          {busy ? (
            <Icon icon={LoaderCircle} size={14} weight="control" className="spin" />
          ) : null}
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
export function Confirm({
  title,
  children,
  label = "Delete",
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  label?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} compact>
      <AsyncForm
        onSubmit={onConfirm}
        submitLabel={label}
        onCancel={onClose}
        danger
      >
        <p>{children}</p>
      </AsyncForm>
    </Modal>
  );
}
const tones: Record<string, string> = {
  active: "success",
  ready: "success",
  published: "success",
  completed: "success",
  complete: "success",
  failed: "danger",
  error: "danger",
  interrupted: "danger",
  denied: "danger",
  expired: "danger",
  needs_attention: "warning",
  running: "warning",
  working: "warning",
  provisioning: "warning",
  pending: "warning",
  queued: "warning",
  starting: "warning",
  cancelling: "warning",
  invited: "warning",
};
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`} data-tone={tones[value] ?? "neutral"}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
