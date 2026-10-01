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
import { AlertCircle, Check, LoaderCircle, X } from "lucide-react";
import { errorMessage } from "../api";

export function ErrorNotice({ message }: { message?: string }) {
  return message ? (
    <div className="notice error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Success({ children }: { children: ReactNode }) {
  return (
    <div className="notice success" role="status">
      <Check size={18} />
      <span>{children}</span>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} /> Loading…
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
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="actions">{actions}</div>
    </header>
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "modal wide" : "modal"}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-header">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
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
}: {
  onSubmit: (data: FormData) => Promise<void>;
  children: ReactNode;
  submitLabel?: string;
  onCancel?: () => void;
  className?: string;
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
        <button className="primary" disabled={busy} type="submit">
          {busy ? <LoaderCircle size={16} className="spin" /> : null}
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
    <Modal title={title} onClose={onClose}>
      <AsyncForm onSubmit={onConfirm} submitLabel={label} onCancel={onClose}>
        <p>{children}</p>
      </AsyncForm>
    </Modal>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
