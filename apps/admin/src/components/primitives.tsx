/**
 * StackMate Admin — shared primitives (ONE file only, design spec §3).
 *
 * Every section uses ONLY these primitives + the token classes in
 * styles/tokens.css. No inline static styles, no new colors, no second
 * icon set (Lucide only, 16px default, stroke-width 2, currentColor).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  formatDisplayDateDDMMYYYY,
  formatDisplayDateTimeDDMMYYYY,
  formatMinorMoney,
} from "../lib/api-client";

/* ------------------------------------------------------------------ */
/* Spinner                                                             */
/* ------------------------------------------------------------------ */
export function Spinner() {
  return <span className="sm-spinner" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Button — exactly five variants (spec §3.1). One primary per page.    */
/* ------------------------------------------------------------------ */
type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost"
  | "danger-ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  loading?: boolean;
  icon?: LucideIcon;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon: Icon,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`sm-btn sm-btn-${variant}${size === "sm" ? " sm-btn-sm" : ""}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : Icon ? <Icon size={16} strokeWidth={2} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  className,
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`sm-btn sm-btn-ghost sm-btn-icon${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`sm-input ${props.className ?? ""}`.trim()} />;
}

export function Select({
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`sm-select ${props.className ?? ""}`.trim()}>
      {children}
    </select>
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={`sm-textarea ${props.className ?? ""}`.trim()} />
  );
}

/* ------------------------------------------------------------------ */
/* Field — label + required marker + one short hint + one error         */
/* ------------------------------------------------------------------ */
export function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="sm-field">
      <label className="sm-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="sm-required"> *</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <span className="sm-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="sm-field-error" id={errorId} role="alert">
          <AlertCircle size={14} strokeWidth={2} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: 14,
        cursor: "pointer",
      }}
    >
      <input type="checkbox" className="sm-checkbox" {...props} />
      {label}
    </label>
  );
}

export function Switch({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: 14,
        cursor: "pointer",
      }}
    >
      <input type="checkbox" role="switch" className="sm-switch" {...props} />
      {label}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* StatusBadge — dot + sentence-cased word, never color alone          */
/* ------------------------------------------------------------------ */
type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  active: "success",
  verified: "success",
  paid: "success",
  approved: "success",
  delivered: "success",
  published: "success",
  accepted: "success",
  enabled: "success",
  completed: "success",
  pending: "warning",
  pending_verification: "warning",
  draft: "warning",
  trial: "warning",
  past_due: "warning",
  grace_period: "warning",
  processing: "warning",
  suspended: "warning",
  inactive: "neutral",
  retired: "neutral",
  archived: "neutral",
  disabled: "neutral",
  cancelled: "danger",
  failed: "danger",
  rejected: "danger",
  denied: "danger",
  revoked: "danger",
  deactivated: "danger",
  blocked: "danger",
  dead_letter: "danger",
  expired: "danger",
  void: "danger",
  refunded: "danger",
};

function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const variant = STATUS_VARIANTS[status.toLowerCase()] ?? "neutral";
  return (
    <span className={`sm-badge sm-badge-${variant}`}>
      <span className="sm-badge-dot" aria-hidden="true" />
      {label ?? sentenceCase(status)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Money / date cells — tabular sans (NOT mono, spec §2.1)             */
/* ------------------------------------------------------------------ */
export function MoneyCell({
  currency,
  minor,
}: {
  currency: string;
  minor: number;
}) {
  return <span className="sm-tabular">{formatMinorMoney(minor, currency)}</span>;
}

export function DateCell({ value }: { value: string | null | undefined }) {
  return (
    <span className="sm-tabular">{value ? formatDisplayDateDDMMYYYY(value) : "—"}</span>
  );
}

export function DateTimeCell({ value }: { value: string | null | undefined }) {
  return (
    <span className="sm-tabular">
      {value ? formatDisplayDateTimeDDMMYYYY(value) : "—"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Card, Toolbar, Chip, Tabs                                           */
/* ------------------------------------------------------------------ */
export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sm-card">
      {title ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <h2 className="sm-card-title">{title}</h2>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="sm-toolbar">{children}</div>;
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="sm-chip"
      aria-pressed={active ?? false}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.key === active);
    const next =
      e.key === "ArrowRight"
        ? (idx + 1) % tabs.length
        : (idx - 1 + tabs.length) % tabs.length;
    const nextTab = tabs[next];
    if (!nextTab) return;
    onChange(nextTab.key);
    listRef.current
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")
      [next]?.focus();
  };
  return (
    <div className="sm-tabs" role="tablist" onKeyDown={onKeyDown} ref={listRef}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === active}
          className="sm-tab"
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagination (spec §4.1 footer)                                       */
/* ------------------------------------------------------------------ */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="sm-pagination">
      <span>
        Showing {from}–{to} of {total}
      </span>
      <div className="sm-pagination-controls">
        {onPageSizeChange ? (
          <Select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rows per page"
            style={{ width: "auto", height: 28, fontSize: 13 }}
          >
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </Select>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </Button>
        <span aria-live="polite">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Breadcrumb                                                          */
/* ------------------------------------------------------------------ */
export function Breadcrumb({
  items,
}: {
  items: { label: string; href?: string }[];
}) {
  return (
    <nav className="sm-breadcrumb" aria-label="Breadcrumb">
      {items.map((item, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          {item.href ? (
            <a href={item.href}>{item.label}</a>
          ) : (
            <span className="sm-breadcrumb-current" aria-current="page">
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* CopyButton — masked secrets by default is the caller's job; the      */
/* button copies the given value and shows "Copied" feedback.          */
/* ------------------------------------------------------------------ */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — no silent failure elsewhere to fix */
    }
  };
  return (
    <button
      type="button"
      className="sm-copy-btn"
      aria-label={label ?? "Copy to clipboard"}
      title={copied ? "Copied" : "Copy"}
      onClick={onCopy}
    >
      {copied ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={2} />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog / Drawer — Esc closes, focus is trapped + returned           */
/* ------------------------------------------------------------------ */
function useFocusTrap(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      );
    const first = focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) return;
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus();
    };
  }, [active, onClose]);
  return ref;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "sm",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <div
      className="sm-dialog-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`sm-dialog${size === "md" ? " sm-dialog-md" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="sm-dialog-header">
          <h2 className="sm-section-title">{title}</h2>
          <IconButton label="Close dialog" icon={X} onClick={onClose} />
        </div>
        <div className="sm-dialog-body">{children}</div>
        {footer ? <div className="sm-dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="sm-drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="sm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="sm-dialog-header">
          <h2 className="sm-section-title">{title}</h2>
          <IconButton label="Close drawer" icon={X} onClick={onClose} />
        </div>
        <div className="sm-dialog-body" style={{ flex: 1 }}>
          {children}
        </div>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* ConfirmDialog + useConfirm (promise-based, one dialog at a time)     */
/* ------------------------------------------------------------------ */
interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<
  (req: Omit<ConfirmRequest, "resolve">) => Promise<boolean>
>(() => Promise.resolve(false));

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ask = useCallback(
    (req: Omit<ConfirmRequest, "resolve">) =>
      new Promise<boolean>((resolve) => setRequest({ ...req, resolve })),
    [],
  );
  const close = useCallback(
    (value: boolean) => {
      request?.resolve(value);
      setRequest(null);
    },
    [request],
  );
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {request ? (
        <Dialog
          open
          onClose={() => close(false)}
          title={request.title}
          footer={
            <>
              <Button variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                variant={request.danger ? "danger" : "primary"}
                onClick={() => close(true)}
              >
                {request.confirmLabel ?? "Confirm"}
              </Button>
            </>
          }
        >
          {request.body}
        </Dialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Alert                                                               */
/* ------------------------------------------------------------------ */
type AlertVariant = "success" | "warning" | "danger" | "info";

const ALERT_ICONS: Record<AlertVariant, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
  info: Info,
};

export function Alert({
  variant,
  children,
  onDismiss,
  role,
}: {
  variant: AlertVariant;
  children: ReactNode;
  onDismiss?: () => void;
  role?: "alert" | "status";
}) {
  const Icon = ALERT_ICONS[variant];
  return (
    <div
      className={`sm-alert sm-alert-${variant}`}
      role={role ?? (variant === "danger" ? "alert" : "status")}
    >
      <Icon size={16} strokeWidth={2} />
      <div style={{ flex: 1 }}>{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="sm-copy-btn sm-alert-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={16} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts — success/info auto-dismiss (5s); errors stay                */
/* ------------------------------------------------------------------ */
interface ToastItem {
  id: number;
  title: string;
  message?: string;
  variant: AlertVariant;
  sticky: boolean;
}

const ToastContext = createContext<{
  toast: (t: { title: string; message?: string; variant?: AlertVariant }) => void;
}>({ toast: () => undefined });

export function useToast() {
  return useContext(ToastContext);
}

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback(
    ({
      title,
      message,
      variant = "success",
    }: {
      title: string;
      message?: string;
      variant?: AlertVariant;
    }) => {
      const id = ++toastSeq;
      const sticky = variant === "danger";
      const item: ToastItem = {
        id,
        title,
        variant,
        sticky,
        ...(message ? { message } : {}),
      };
      setToasts((prev) => [...prev, item]);
      if (!sticky) {
        window.setTimeout(() => dismiss(id), 5000);
      }
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sm-toast-viewport" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ALERT_ICONS[t.variant];
          return (
            <div
              key={t.id}
              className="sm-toast"
              role={t.variant === "danger" ? "alert" : "status"}
            >
              <Icon size={16} strokeWidth={2} style={{ marginTop: 2, flex: "none" }} />
              <div style={{ flex: 1 }}>
                <div className="sm-toast-title">{t.title}</div>
                {t.message ? <div className="sm-toast-message">{t.message}</div> : null}
              </div>
              <button
                type="button"
                className="sm-copy-btn"
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.id)}
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton, EmptyState, ErrorState                                    */
/* ------------------------------------------------------------------ */
export function Skeleton({ height = 16, width }: { height?: number; width?: string }) {
  return (
    <div
      className="sm-skeleton"
      style={{ height, width: width ?? "100%" }}
      aria-hidden="true"
    />
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="sm-table-wrap" aria-label="Loading">
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} height={20} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="sm-empty">
      <Icon size={18} strokeWidth={2} className="sm-empty-icon" />
      <div className="sm-empty-title">{title}</div>
      <p>{body}</p>
      {actionLabel && onAction ? (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="sm-error">
      <AlertCircle size={18} strokeWidth={2} className="sm-error-icon" />
      <div className="sm-error-title">Something went wrong</div>
      <p>{message}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
