import React, { useEffect, useRef, useState } from "react";
import { Renderer } from "@k8slens/extensions";

/**
 * Thin wrappers around Lens UI primitives with plain-HTML fallbacks, so a host
 * version that does not export one of them still renders something usable.
 */
const Component: Record<string, any> = ((Renderer as unknown as { Component?: Record<string, any> }).Component) ?? {};

/** Hover hints use the native `title` attribute — Lens' own Tooltip overlays
 *  neighbouring controls and hides them, which users read as a blocking toast. */
function withTitle(node: React.ReactNode, title?: string): JSX.Element {
  if (!title) return <>{node}</>;
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center" }}>
      {node}
    </span>
  );
}

export function Icon({ material, tooltip, interactive }: { material: string; tooltip?: string; interactive?: boolean }): JSX.Element {
  const content = Component.Icon ? (
    <Component.Icon material={material} small interactive={interactive} />
  ) : (
    <span aria-label={material} style={{ fontFamily: "monospace", opacity: 0.75, fontSize: 12 }}>
      [{material}]
    </span>
  );
  return withTitle(content, tooltip);
}

/**
 * OpenLens' Drawer closes itself on any click whose `event.target` is not inside
 * a `.Drawer` — a *detached* target (a button that unmounts its own dialog on
 * click) fails that test, so the whole sidebar vanished. The Drawer skips its
 * check when the click is `defaultPrevented`, so every button of ours marks its
 * click handled. See `viewer-state.ts` for the same host behaviour.
 */
function handledClick(onClick?: () => void) {
  if (!onClick) return undefined;
  return (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    onClick();
  };
}

export function ActionButton(props: {
  label: string;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}): JSX.Element {
  const { label, onClick, primary, disabled, title } = props;
  const handleClick = handledClick(onClick);

  const content = Component.Button ? (
    <Component.Button label={label} primary={primary} disabled={disabled} onClick={handleClick} small />
  ) : (
    <button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      style={{
        padding: "4px 10px",
        borderRadius: 4,
        border: "1px solid rgba(128,128,128,.5)",
        background: primary ? "#3d7eff" : "transparent",
        color: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );

  return withTitle(content, title);
}

/**
 * Small self-drawn select.
 *
 * A native `<select>` cannot be styled consistently: Chromium paints its own
 * rounded corners and a blue "pill" highlight in the popup. This keeps the look
 * in line with the rest of the overlay.
 */
export function SimpleSelect(props: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  testId?: string;
  title?: string;
}): JSX.Element {
  const { value, options, onChange, testId, title } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = options.find((option) => option.value === value)?.label ?? value;

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        data-testid={testId}
        title={title}
        onClick={() => setOpen((previous) => !previous)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 110,
          justifyContent: "space-between",
          padding: "3px 8px",
          borderRadius: 3,
          border: "1px solid rgba(128,128,128,.5)",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current}</span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>▼</span>
      </button>

      {open ? (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 2,
            minWidth: "100%",
            maxHeight: 240,
            overflow: "auto",
            padding: 3,
            borderRadius: 4,
            border: "1px solid rgba(128,128,128,.4)",
            background: "var(--mainBackground, #1e2124)",
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            zIndex: 30,
          }}
        >
          {options.map((option) => (
            <div
              key={option.value}
              data-option={option.value}
              onClick={(event) => {
                event.preventDefault(); // the popup (and this row) unmounts right away
                setOpen(false);
                if (option.value !== value) onChange(option.value);
              }}
              style={{
                padding: "4px 8px",
                borderRadius: 3,
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: option.value === value ? "rgba(61,126,255,.22)" : "transparent",
                fontWeight: option.value === value ? 600 : 400,
              }}
              onMouseEnter={(event) => {
                if (option.value !== value) (event.currentTarget as HTMLElement).style.background = "rgba(128,128,128,.2)";
              }}
              onMouseLeave={(event) => {
                if (option.value !== value) (event.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              {option.label}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}

export function TextInput(props: { value: string; onChange: (value: string) => void; placeholder?: string }): JSX.Element {
  const { value, onChange, placeholder } = props;
  if (Component.Input) {
    return <Component.Input value={value} onChange={(next: string) => onChange(next)} placeholder={placeholder} />;
  }
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      style={{ width: "100%", padding: "6px 8px", borderRadius: 4, border: "1px solid rgba(128,128,128,.5)", background: "transparent", color: "inherit" }}
    />
  );
}

/**
 * Search field with an inline "clear" button.
 *
 * Committing is explicit (Enter) rather than per keystroke, so the list does not
 * flicker while a name is being typed; the ✕ button drops the filter entirely.
 * No keyboard shortcut beyond Enter: Esc belongs to the surrounding overlay.
 */
export function SearchBox(props: {
  value: string;
  onChange: (value: string) => void;
  /** Enter — apply the typed query. */
  onCommit: () => void;
  /** ✕ — drop the query and show everything again. */
  onClear: () => void;
  /** A committed query is in effect (keeps the ✕ visible once the input is empty). */
  active?: boolean;
  placeholder?: string;
  title?: string;
  testId?: string;
}): JSX.Element {
  const { value, onChange, onCommit, onClear, active, placeholder, title, testId } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const showClear = Boolean(value) || Boolean(active);

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <input
        ref={inputRef}
        type="text"
        data-testid={testId}
        title={title}
        value={value}
        spellCheck={false}
        placeholder={placeholder ?? "搜索文件名"}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
        }}
        style={{
          width: 150,
          padding: "3px 20px 3px 8px",
          borderRadius: 3,
          border: `1px solid ${active ? "rgba(61,126,255,.75)" : "rgba(128,128,128,.5)"}`,
          background: "transparent",
          color: "inherit",
          font: "inherit",
        }}
      />
      {/* Kept mounted (hidden, not removed) on purpose: clearing empties the box,
          which would otherwise unmount the very node that was just clicked — and
          a detached click target reads as "outside the drawer" to OpenLens. */}
      <button
        type="button"
        data-testid={testId ? `${testId}-clear` : undefined}
        title="清除搜索，显示全部"
        aria-label="清除搜索"
        aria-hidden={showClear ? undefined : "true"}
        tabIndex={showClear ? 0 : -1}
        onClick={(event) => {
          event.preventDefault();
          if (!showClear) return;
          onClear();
          inputRef.current?.focus();
        }}
        style={{
          position: "absolute",
          right: 2,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          padding: 0,
          borderRadius: 8,
          border: "none",
          background: "transparent",
          color: "inherit",
          cursor: showClear ? "pointer" : "default",
          fontSize: 10,
          lineHeight: 1,
          opacity: showClear ? 0.6 : 0,
          visibility: showClear ? "visible" : "hidden",
          pointerEvents: showClear ? "auto" : "none",
        }}
      >
        ✕
      </button>
    </span>
  );
}

export function Modal(props: { title: string; children: React.ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div
      role="presentation"
      onClick={(event) => {
        event.preventDefault(); // closing unmounts the clicked node — see handledClick
        props.onClose();
      }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: "var(--mainBackground, #1e2124)",
          color: "inherit",
          padding: 16,
          borderRadius: 8,
          minWidth: 330,
          maxWidth: 560,
          border: "1px solid rgba(128,128,128,.4)",
          boxShadow: "0 12px 32px rgba(0,0,0,.45)",
        }}
      >
        <h3 style={{ margin: "0 0 12px" }}>{props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div style={{ border: "1px solid #d9534f", borderRadius: 6, padding: "8px 10px", color: "#ff8a80", fontSize: 12 }}>
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{message}</div>
      {onRetry ? (
        <div style={{ marginTop: 6 }}>
          <ActionButton label="重试" onClick={onRetry} />
        </div>
      ) : null}
    </div>
  );
}
