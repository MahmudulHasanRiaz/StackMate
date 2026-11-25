/**
 * StackMate Admin — shared primitives (ONE file only, design spec §3).
 *
 * Every section uses ONLY these primitives + the token classes in
 * styles/tokens.css. No inline static styles, no new colors, no second
 * icon set (Lucide only, 16px default, stroke-width 2, currentColor).
 */
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { gravatarUrl } from "../lib/gravatar";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Info,
  MoreHorizontal,
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
/* Button — six variants (Neon button system, images 80/81/82,      */
/* corrected 2026-11-16 ~03:07 +06 from Neon's live CSS; system       */
/* decided 2026-11-19, audit D-2 — the old "exactly three" rule is    */
/* retired). Three MAIN variants — PRIMARY (white/black), SECONDARY   */
/* (grey outline), ACCENT (green outline for brand CTAs) — plus       */
/* DANGER (solid red confirm action, owner-approved Defect B) and     */
/* GHOST forms (ghost + danger-ghost, the text-button pattern for     */
/* icon actions, menus and low-emphasis actions). PRIMARY is          */
/* reserved for the SINGLE most-important action on a page —          */
/* "Create product" on the Products list (mirrors Neon's "Create      */
/* branch"); one white primary per page (audit D-3). Every other      */
/* main action is ACCENT: green outline, filling with the green       */
/* gradient on hover/focus (Neon image-85).                           */
/* ------------------------------------------------------------------ */
type ButtonVariant =
  | "primary"
  | "secondary"
  | "accent"
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
/* InfoButton — the (i) button beside a page title (clean header       */
/* rule, 2026-11-16). Page descriptions live HERE, hidden until the    */
/* user opens them — never visible by default, so headers stay clean   */
/* and text-light. The panel is styled as Neon's TOOLTIP (images       */
/* 85/95 dark, c856b3f4 light): small box, compact padding, caret      */
/* pointing up at the button, positioned below it; colors invert per   */
/* theme via --sm-tooltip-bg/text — NOT a card or dialog. Portaled +   */
/* fixed-positioned like RowMenu (same open/close contract: click      */
/* toggles, Esc closes and returns focus, outside pointerdown /       */
/* scroll / resize close, flips above the trigger near the viewport    */
/* bottom). The 26px icon button becomes 40px at <=640px via the      */
/* shared .sm-btn-icon rule in tokens.css.                            */
/* ------------------------------------------------------------------ */
export function InfoButton({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    caretLeft: number;
    flipped: boolean;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openInfo = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    // Caret sits on the trigger's horizontal center, clamped inside
    // the panel so it never pokes past an edge.
    const caretLeft = Math.max(
      10,
      Math.min(rect.left + rect.width / 2 - left, width - 10),
    );
    setPos({ top: rect.bottom + 11, left, width, caretLeft, flipped: false });
    setOpen(true);
  }, []);

  // Flip above the trigger when the panel would overflow the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const panel = panelRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!panel || !rect) return;
    const height = panel.getBoundingClientRect().height;
    if (pos.top + height > window.innerHeight - 8) {
      setPos({
        top: Math.max(8, rect.top - height - 11),
        left: pos.left,
        width: pos.width,
        caretLeft: pos.caretLeft,
        flipped: true,
      });
    }
    // Runs once per open on purpose: the position is set on open, then
    // flipped at most once. Re-running on `pos` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="sm-btn sm-btn-ghost sm-btn-icon"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="About this page"
        title="About this page"
        onClick={() => (open ? close() : openInfo())}
      >
        <Info size={16} strokeWidth={2} />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="sm-info-panel"
              role="dialog"
              aria-label="About this page"
              data-flipped={pos.flipped || undefined}
              style={{ top: pos.top, left: pos.left, width: pos.width }}
            >
              <span
                className="sm-info-caret"
                style={{ left: pos.caretLeft }}
                aria-hidden="true"
              />
              <p>{text}</p>
            </div>,
            document.body,
          )
        : null}
    </>
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

/* ------------------------------------------------------------------ */
/* SearchableSelect — typable combobox (PLAN §29, ADR-0010).            */
/* Replaces every entity <Select>: a native select's OS popup has no    */
/* type-to-search, and at scale the option list is unusable. The        */
/* trigger is a typable <input> wearing the .sm-select look; the       */
/* option list is a portaled listbox reusing .sm-row-menu (same        */
/* open/close contract as MenuSelect: click toggles, Esc closes and     */
/* restores the selected label, outside pointerdown / scroll / resize   */
/* close, flips above the trigger near the viewport bottom).            */
/*   Server mode — loadOptions(query, signal): the query runs           */
/*   server-side over the FULL dataset (list ?q=), debounced 200ms;    */
/*   opening with an empty query loads the first page (limit 25).      */
/*   Local mode — options: filtered client-side as you type (small     */
/*   bounded lists only: per-order installments, per-customer contacts, */
/*   server-provided distinct filter values).                           */
/*   leadingOptions: static first options that are never filtered      */
/*   (All… / None / Unlinked). selectedLabel / resolveLabel: the label */
/*   to show when closed while the value is not among the loaded       */
/*   options (e.g. a filter value restored from the URL). Keyboard:    */
/*   ArrowDown/Up moves, Enter chooses the active option, Esc closes.  */
/* ------------------------------------------------------------------ */
export interface SearchableOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Caller-attached record (e.g. the order row) — handed back as the
   *  second onChange argument so auto-fill handlers (ticket linked
   *  records) can read linked ids without a second fetch. */
  data?: unknown;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  loadOptions,
  selectedLabel,
  resolveLabel,
  leadingOptions = [],
  placeholder,
  disabled,
  ariaLabel,
  id,
  name,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string, option?: SearchableOption) => void;
  options?: SearchableOption[];
  /** Server search. May return a bare list, or `{ options, capped }`
   *  when the server capped the page (audit L-01) — the capped hint
   *  below renders only from the object form. */
  loadOptions?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<SearchableOption[] | { options: SearchableOption[]; capped: boolean }>;
  selectedLabel?: string | undefined;
  resolveLabel?: (
    value: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  leadingOptions?: SearchableOption[];
  placeholder: string;
  disabled?: boolean;
  ariaLabel: string;
  id?: string;
  /** Forwarded to the combobox input (audit L-06) so the control is
   *  form-identifiable like every other input. */
  name?: string;
  /** Wired by Field (audit M-10) — the hint/error ids reach the
   *  input through this prop because Field clones the component. */
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [results, setResults] = useState<SearchableOption[]>([]);
  const [loading, setLoading] = useState(false);
  /** Audit M-04: a failed server search must not masquerade as "No
   *  results" — the flag renders "Search failed — try again." */
  const [searchError, setSearchError] = useState(false);
  /** Audit L-01: true when the server capped the page; renders the
   *  "Showing first N — refine your search" hint. */
  const [capped, setCapped] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [chosenLabel, setChosenLabel] = useState<{ value: string; label: string } | null>(null);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listId = useId();

  const leading = leadingOptions;
  const displayLabel =
    leading.find((o) => o.value === value)?.label ??
    results.find((o) => o.value === value)?.label ??
    (options ?? []).find((o) => o.value === value)?.label ??
    (chosenLabel !== null && chosenLabel.value === value ? chosenLabel.label : null) ??
    selectedLabel ??
    resolvedLabel ??
    "";

  // When closed the input shows the selected label; when open it shows
  // what the user typed (empty on open — the placeholder carries the
  // current selection as a hint).
  useEffect(() => {
    if (!open) setText(displayLabel);
    // Runs on open/close + whenever the label resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, displayLabel]);

  // Resolve the label for a preset value that is not among the loaded
  // options (e.g. a filter value restored from the URL). Runs once per
  // value; a 404/empty result leaves the raw value hidden — the input
  // falls back to the placeholder instead of showing a UUID.
  useEffect(() => {
    if (!resolveLabel || value === "") return;
    if (
      leading.some((o) => o.value === value) ||
      (options ?? []).some((o) => o.value === value) ||
      selectedLabel !== undefined
    ) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    resolveLabel(value, controller.signal)
      .then((label) => {
        if (!cancelled && label) setResolvedLabel(label);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const runSearch = useCallback(
    async (query: string, typed: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setSearchError(false);
      setCapped(false);
      try {
        let loaded: SearchableOption[];
        if (loadOptions) {
          const res = await loadOptions(query, controller.signal);
          // Object form carries the server cap (audit L-01); the bare
          // array form is the legacy shape and stays supported.
          if (Array.isArray(res)) {
            loaded = res;
          } else {
            loaded = res.options;
            setCapped(res.capped);
          }
        } else {
          const q = query.trim().toLowerCase();
          loaded = (options ?? []).filter(
            (o) => !q || o.label.toLowerCase().includes(q),
          );
        }
        if (controller.signal.aborted) return;
        setResults(loaded);
        // Typing auto-highlights the first MATCH (past the static
        // leading options) so Enter picks the top result; opening with
        // an empty query highlights the current selection if present.
        if (typed) {
          setActiveIndex(loaded.length > 0 ? leading.length : -1);
        } else if (loaded.length === 0) {
          setActiveIndex(-1);
        } else {
          const selectedIdx = loaded.findIndex((o) => o.value === value);
          setActiveIndex(selectedIdx >= 0 ? selectedIdx + leading.length : -1);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setResults([]);
          setCapped(false);
          // Audit M-04: the empty list below is NOT "no matches" —
          // the search itself failed.
          setSearchError(true);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [loadOptions, options, leading.length, value],
  );

  const openMenu = useCallback(() => {
    if (disabled) return;
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)),
      width: Math.max(240, Math.min(rect.width, window.innerWidth - 16)),
    });
    setText("");
    setOpen(true);
    void runSearch("", false);
  }, [disabled, runSearch]);

  const close = useCallback(() => {
    abortRef.current?.abort();
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Debounced search while typing (200ms); the opening search runs
  // immediately in openMenu, so the effect skips the first run.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (!open) {
      firstRunRef.current = true;
      return;
    }
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => void runSearch(text, true), 200);
    return () => window.clearTimeout(timer);
  }, [open, text, runSearch]);

  // Flip above the trigger when the menu would overflow the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const menu = menuRef.current;
    const rect = inputRef.current?.getBoundingClientRect();
    if (!menu || !rect) return;
    const height = menu.getBoundingClientRect().height;
    if (pos.top + height > window.innerHeight - 8) {
      setPos({ ...pos, top: Math.max(8, rect.top - height - 4) });
    }
    // Runs once per open on purpose, like MenuSelect's flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      close();
    };
    const onScrollOrResize = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  // Keep the active option visible inside the scrollable listbox.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    // scrollIntoView is guarded: jsdom (and some embedded webviews) do
    // not implement it, and an unguarded call crashes the whole app via
    // the error boundary the moment a combobox highlights a match.
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const shown = useMemo(
    () => [...leading, ...results.filter((r) => !leading.some((l) => l.value === r.value))],
    [leading, results],
  );

  const choose = (option: SearchableOption) => {
    setChosenLabel({ value: option.value, label: option.label });
    setResolvedLabel(null);
    onChange(option.value, option);
    close();
    inputRef.current?.focus();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      if (shown.length === 0) return;
      const next =
        activeIndex === -1
          ? e.key === "ArrowDown"
            ? 0
            : shown.length - 1
          : (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      setActiveIndex(next);
    } else if (e.key === "Enter") {
      if (open && activeIndex >= 0 && shown[activeIndex]) {
        e.preventDefault();
        choose(shown[activeIndex]!);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close();
      }
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-autocomplete="list"
        autoComplete="off"
        className="sm-select sm-searchable-select"
        placeholder={open ? displayLabel || placeholder : placeholder}
        value={text}
        disabled={disabled}
        onFocus={() => {
          if (!open) openMenu();
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (!open) openMenu();
        }}
        onKeyDown={onInputKeyDown}
        onBlur={(e) => {
          // Focus moving into the listbox keeps it open; anywhere else
          // closes it (the display label is restored by the effect).
          if (menuRef.current?.contains(e.relatedTarget as Node)) return;
          close();
        }}
      />
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              className="sm-row-menu sm-searchable-list"
              role="listbox"
              aria-label={ariaLabel}
              style={{ top: pos.top, left: pos.left, width: pos.width, right: "auto" }}
            >
              {shown.length === 0 && !loading ? (
                <div className="sm-menu-item" aria-disabled="true">
                  {searchError
                    ? "Search failed — try again."
                    : "No results — try a different search."}
                </div>
              ) : (
                shown.map((o, i) => (
                  <button
                    key={`${o.value}:${i}`}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    data-index={i}
                    className="sm-menu-item"
                    data-active={i === activeIndex || undefined}
                    disabled={o.disabled}
                    // mousedown preventDefault keeps focus in the input so
                    // the blur handler cannot close the list before click.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <span className="sm-menu-item-label">{o.label}</span>
                    {o.value === value ? (
                      <Check size={14} strokeWidth={2} aria-hidden="true" />
                    ) : null}
                  </button>
                ))
              )}
              {/* Audit M-04: with static leading options present a
                  failed search still shows them — the failure gets
                  its own row instead of silence. Audit L-01: the cap
                  hint names the count actually returned. */}
              {searchError && shown.length > 0 && !loading ? (
                <div className="sm-menu-item" aria-disabled="true">
                  Search failed — try again.
                </div>
              ) : null}
              {capped && shown.length > 0 && !loading ? (
                <div className="sm-menu-item" aria-disabled="true">
                  Showing first {results.length} — refine your search.
                </div>
              ) : null}
              {loading ? (
                <div className="sm-menu-item" aria-disabled="true">
                  Searching…
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
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
  hint?: string | undefined;
  error?: string | undefined;
  /** The id of the control this label belongs to. Optional in the
   *  type — the section call sites pass plain controls without it —
   *  but EFFECTIVELY required: when it is missing, Field generates
   *  one and injects it into a single valid-element child, so the
   *  label is always associated (audit M-08). The sections agent is
   *  adding explicit htmlFor at the call sites; until then the
   *  generated id closes the gap. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const hintId = useId();
  const errorId = useId();
  const generatedId = useId();
  // Audit M-10: the hint/error ids existed but were never wired to
  // the control — aria-describedby was used 0 times in the app. The
  // described-by value is the error id when an error is present,
  // else the hint id.
  const describedBy = [error ? errorId : null, !error && hint ? hintId : null]
    .filter(Boolean)
    .join(" ");
  const controlId = htmlFor ?? generatedId;
  // Inject id + aria-describedby into a single valid-element child
  // (input/select/textarea, or a component that forwards id, e.g.
  // SearchableSelect). Wrappers, fragments and multi-child content
  // render untouched — the label still points at controlId, which
  // the sections agent's explicit htmlFor will resolve.
  let child = children;
  if (isValidElement(children)) {
    const el = children as ReactElement<Record<string, unknown>>;
    const existingDescribedBy =
      typeof el.props["aria-describedby"] === "string"
        ? (el.props["aria-describedby"] as string)
        : "";
    const mergedDescribedBy = [existingDescribedBy, describedBy]
      .filter(Boolean)
      .join(" ");
    child = cloneElement(el, {
      id: (el.props.id as string | undefined) ?? controlId,
      ...(mergedDescribedBy ? { "aria-describedby": mergedDescribedBy } : {}),
    });
  }
  return (
    <div className="sm-field">
      <label className="sm-label" htmlFor={controlId}>
        {label}
        {required ? <span className="sm-required"> *</span> : null}
      </label>
      {child}
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

/* ------------------------------------------------------------------ */
/* GroupField — D-08: the group variant of Field. For checkbox/radio  */
/* groups and other multi-control fields a <label htmlFor> names one  */
/* control that does not exist; the group instead carries            */
/* role="group" + aria-labelledby so screen readers (and label       */
/* clicks via the group label) associate the whole set. Use this      */
/* wherever Field wraps a group instead of a single control.          */
/* ------------------------------------------------------------------ */
export function GroupField({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy = [error ? errorId : null, !error && hint ? hintId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="sm-field" role="group" aria-labelledby={labelId} aria-describedby={describedBy || undefined}>
      <span className="sm-label" id={labelId}>
        {label}
        {required ? <span className="sm-required"> *</span> : null}
      </span>
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
  id,
  name,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Audit L-09: explicit id/name — the spread forwarded them in
   *  practice, but the signature never said so. */
  id?: string;
  name?: string;
}) {
  return (
    <label className="sm-check-label">
      <input type="checkbox" className="sm-checkbox" id={id} name={name} {...props} />
      {label}
    </label>
  );
}

export function Switch({
  label,
  id,
  name,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Audit L-09: explicit id/name — see Checkbox. */
  id?: string;
  name?: string;
}) {
  return (
    <label className="sm-check-label">
      <input type="checkbox" role="switch" className="sm-switch" id={id} name={name} {...props} />
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
        <div className="sm-card-head">
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
  // Audit M-01: the page was never clamped — after a delete or a
  // filter narrowed the list, page 2 of 1 rendered an empty tbody
  // with "Showing 26–25 of 25". Step back to the last page (which
  // also corrects the URL param at the ListTable level) and display
  // the clamped page so no render ever shows an impossible range.
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  useEffect(() => {
    if (page > totalPages) onPageChange(totalPages);
  }, [page, totalPages, onPageChange]);
  const from = total === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const to = Math.min(total, clampedPage * pageSize);
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
            className="sm-select-sm"
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
          disabled={clampedPage <= 1}
          onClick={() => onPageChange(clampedPage - 1)}
        >
          Prev
        </Button>
        <span aria-live="polite">
          Page {clampedPage} of {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={clampedPage >= totalPages}
          onClick={() => onPageChange(clampedPage + 1)}
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
        <span key={i} className="sm-breadcrumb-item">
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
/* Avatar — initials square tile (account menu; Neon uses square       */
/* tiles, not circles — CORE pass C2).                                 */
/* ------------------------------------------------------------------ */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.charAt(0) ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
  return (first + second).toUpperCase();
}

/* Avatar — custom uploaded photo first (audit M-23), Gravatar
   second (d=404 → the <img> errors and the next fallback shows),
   initials otherwise. The photo is square (4px radius, never
   circular — radius rules). */
export function Avatar({
  name,
  email,
  avatarUrl,
  size = "md",
}: {
  name: string;
  email?: string | null | undefined;
  /** Custom avatar URL (users.avatar_url, set from Profile → media
   *  picker). null/undefined means "no custom photo". */
  avatarUrl?: string | null | undefined;
  size?: "md" | "lg";
}) {
  const [customFailed, setCustomFailed] = useState(false);
  const [gravatarFailed, setGravatarFailed] = useState(false);
  // A new photo/email retries the photo (e.g. switching accounts or
  // after uploading a new avatar).
  useEffect(() => {
    setCustomFailed(false);
    setGravatarFailed(false);
  }, [avatarUrl, email]);
  const customUrl = avatarUrl && !customFailed ? avatarUrl : null;
  const gravatar = !customUrl && !gravatarFailed ? gravatarUrl(email, size === "lg" ? 72 : 56) : null;
  const url = customUrl ?? gravatar;
  return (
    <span
      className={`sm-avatar${size === "lg" ? " sm-avatar-lg" : ""}`}
      aria-hidden="true"
    >
      {url ? (
        <img
          src={url}
          alt=""
          onError={() => {
            if (customUrl) setCustomFailed(true);
            else setGravatarFailed(true);
          }}
        />
      ) : (
        getInitials(name)
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Menu — dropdown (account menu). Outside click + Esc close, arrow    */
/* keys cycle items, focus returns to the trigger on close. Any        */
/* MenuItem click closes the menu after its own action runs.           */
/* ------------------------------------------------------------------ */
const MenuContext = createContext<{ close: () => void }>({
  close: () => undefined,
});

export function Menu({
  trigger,
  triggerLabel,
  triggerClassName,
  children,
}: {
  trigger: ReactNode;
  triggerLabel: string;
  triggerClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const menuItems = useCallback(
    () =>
      Array.from(
        wrapRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemradio"]',
        ) ?? [],
      ),
    [],
  );

  const focusItem = useCallback(
    (index: number) => {
      const items = menuItems();
      if (items.length === 0) return;
      const next = items[(index + items.length) % items.length];
      next?.focus();
    },
    [menuItems],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  const onWrapKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = menuItems();
      const activeIdx = items.findIndex((el) => el === document.activeElement);
      if (activeIdx === -1) {
        focusItem(e.key === "ArrowDown" ? 0 : items.length - 1);
      } else {
        focusItem(activeIdx + (e.key === "ArrowDown" ? 1 : -1));
      }
    }
  };

  return (
    <div className="sm-menu-wrap" ref={wrapRef} onKeyDown={onWrapKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open ? (
        <MenuContext.Provider value={{ close: () => setOpen(false) }}>
          <div className="sm-menu" role="menu" aria-label={triggerLabel}>
            {children}
          </div>
        </MenuContext.Provider>
      ) : null}
    </div>
  );
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="sm-menu-header">{children}</div>;
}

export function MenuSectionLabel({ children }: { children: ReactNode }) {
  return <div className="sm-menu-section-label">{children}</div>;
}

export function MenuDivider() {
  return <div className="sm-menu-divider" role="separator" />;
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger,
  checked,
  role = "menuitem",
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  role?: "menuitem" | "menuitemradio";
}) {
  const { close } = useContext(MenuContext);
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitemradio" ? (checked ?? false) : undefined}
      data-danger={danger || undefined}
      className="sm-menu-item"
      onClick={() => {
        onClick?.();
        close();
      }}
    >
      {Icon ? <Icon size={16} strokeWidth={2} /> : null}
      <span className="sm-menu-item-label">{children}</span>
      {checked ? (
        <span className="sm-menu-item-check" aria-hidden="true">
          <Check size={16} strokeWidth={2} />
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* MenuSub — a submenu row inside a Menu (Neon account menu "Theme",   */
/* image-78). The fly-out opens to the LEFT of the menu (the account   */
/* menu sits at the right edge). Hover opens it; click/Enter toggles;  */
/* ArrowRight opens, ArrowLeft closes. A 150ms close delay bridges    */
/* the 4px gap between the trigger row and the panel so the pointer    */
/* can travel across it without the submenu vanishing.                 */
/* ------------------------------------------------------------------ */
export function MenuSub({
  icon: Icon,
  label,
  children,
}: {
  icon?: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  }, [cancelClose]);
  const openSub = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <div
      className="sm-menu-sub-wrap"
      onMouseEnter={openSub}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        ref={triggerRef}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="sm-menu-item"
        onClick={() => (open ? scheduleClose() : openSub())}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openSub();
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            setOpen(false);
          }
        }}
      >
        {Icon ? <Icon size={16} strokeWidth={2} /> : null}
        <span className="sm-menu-item-label">{label}</span>
        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="sm-menu-sub"
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RowMenu — the "…" per-row action menu (Neon Branches pattern).       */
/* A table with 2+ row actions gets ONE "…" button per row instead of  */
/* a run of inline buttons; single-action tables keep their inline     */
/* button (a one-item menu is worse UX). The dropdown is portaled to    */
/* <body> with fixed positioning — an absolutely-positioned menu       */
/* inside `.sm-table-wrap` (overflow-x: auto) would be clipped.        */
/* Opens below the trigger, flips above it when the viewport bottom    */
/* is near; closes on outside pointerdown, Escape, scroll, resize.    */
/* Arrow keys cycle items; focus returns to the trigger on close.      */
/* ------------------------------------------------------------------ */
export interface RowMenuItem {
  icon?: LucideIcon;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function RowMenu({
  items,
  label = "Row actions",
}: {
  items: RowMenuItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
    setOpen(true);
  }, []);

  // Flip above the trigger when the menu would overflow the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const menu = menuRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!menu || !rect) return;
    const height = menu.getBoundingClientRect().height;
    if (pos.top + height > window.innerHeight - 8) {
      setPos({ top: Math.max(8, rect.top - height - 4), right: pos.right });
    }
    // Runs once per open on purpose: the position is set on open, then
    // flipped at most once. Re-running on `pos` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  const menuItems = useCallback(
    () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      ),
    [],
  );

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = menuItems().filter((el) => !el.hasAttribute("disabled"));
    if (items.length === 0) return;
    const activeIdx = items.findIndex((el) => el === document.activeElement);
    const next =
      activeIdx === -1
        ? e.key === "ArrowDown"
          ? 0
          : items.length - 1
        : (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="sm-btn sm-btn-secondary sm-btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? close() : openMenu())}
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="sm-row-menu"
              role="menu"
              aria-label={label}
              style={{ top: pos.top, right: pos.right }}
              onKeyDown={onMenuKeyDown}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className="sm-menu-item"
                  data-danger={item.danger || undefined}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon ? <item.icon size={16} strokeWidth={2} /> : null}
                  <span className="sm-menu-item-label">{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog / Drawer — Esc closes, focus is trapped + returned           */
/* ------------------------------------------------------------------ */
function useFocusTrap(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose is almost always an inline arrow in the caller, so its
  // identity changes on every parent render. If it stayed in the effect
  // deps, the trap re-ran on EVERY render: the cleanup refocused the
  // pre-dialog element and the body refocused the first focusable item —
  // yanking focus out of a form field after its first keystroke (live
  // defect 2026-11-18: the dashboard Custom-range From field kept only
  // "0" of a typed/pasted date). The trap must run once per open, so
  // onClose is read through a ref and only `active` is a dep.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
    // Audit L-08: initial focus landed on the header Close button
    // (the first focusable in DOM order) — the user had to Tab past
    // it to reach the form. Focus the first FORM control instead;
    // dialogs with no form control (e.g. ConfirmDialog) keep the
    // old behaviour and focus the first focusable item.
    const firstControl = focusables().find((item) =>
      ["INPUT", "SELECT", "TEXTAREA"].includes(item.tagName),
    );
    (firstControl ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open combobox owns Escape: it closes its own listbox, and
        // the dialog must stay open (live defect 2026-11-18: Esc with
        // the wizard's price listbox open closed the whole wizard, so
        // the step had to be driven twice). This listener runs in the
        // capture phase, before the input's own handler, so the check
        // has to happen here — stopPropagation in the combobox is too
        // late. A closed combobox (aria-expanded=false) still lets Esc
        // close the dialog.
        const target = e.target as HTMLElement | null;
        if (
          target?.closest(
            '[role="combobox"][aria-expanded="true"], .sm-searchable-list',
          )
        ) {
          return;
        }
        e.stopPropagation();
        onCloseRef.current();
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
  }, [active]);
  return ref;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "sm",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
  className?: string | undefined;
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
        className={`sm-dialog${size === "md" ? " sm-dialog-md" : ""}${className ? ` ${className}` : ""}`}
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
        <div className="sm-dialog-body sm-flex-1">
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
  /* Headline permanence sentence for the danger warning box — the
     body's first consequence sentence, naming the item (Defect B,
     Neon images 91-94: "This will permanently delete the branch
     staging. Are you sure you want to proceed?"). Falls back to a
     generic line when a danger caller omits it. */
  warning?: string | undefined;
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
          className={request.danger ? "sm-dialog-danger" : undefined}
          footer={
            <>
              <Button variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                variant={request.danger ? "danger" : "accent"}
                onClick={() => close(true)}
              >
                {request.confirmLabel ?? "Confirm"}
              </Button>
            </>
          }
        >
          {request.danger ? (
            <div className="sm-confirm-warning" role="alert">
              <AlertTriangle size={16} strokeWidth={2} />
              <span>{request.warning ?? "This action cannot be undone."}</span>
            </div>
          ) : null}
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
      <div className="sm-flex-1">{children}</div>
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
              <Icon size={16} strokeWidth={2} className="sm-toast-icon" />
              <div className="sm-flex-1">
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
  /* Flat like the list tables (review 2026-11-16: skeletons rendered
     inside a bordered card) — no .sm-table-wrap panel. */
  return (
    <div className="sm-table-flat" aria-label="Loading">
      <div className="sm-table-skeleton">
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
        <Button variant="accent" onClick={onAction}>
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
