import React, { useEffect } from "react";
import ReactDOM from "react-dom";
import { observer } from "mobx-react";

import { FileBrowser } from "./file-browser";
import { viewer } from "./viewer-state";

const PORTAL_ID = "podfs-fullscreen-root";

const CSS = `
.podfs-fs-backdrop {
  position: fixed; inset: 0; z-index: 4000;
  display: flex; padding: 24px; background: rgba(0, 0, 0, .58);
}
.podfs-fs-panel {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px 16px;
  background: var(--mainBackground, #1e2124);
  color: inherit;
  border: 1px solid rgba(128, 128, 128, .4);
  border-radius: 10px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, .5);
}
.podfs-fs-header {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  border-bottom: 1px solid rgba(128, 128, 128, .25); padding-bottom: 8px;
}
.podfs-fs-title { font-size: 15px; font-weight: 600; }
.podfs-fs-sub { opacity: .7; font-size: 12px; }
.podfs-fs-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.podfs-fs-back {
  margin-left: auto; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 24px; border-radius: 4px; cursor: pointer; font-size: 13px; line-height: 1;
  border: 1px solid rgba(128, 128, 128, .5); color: inherit; text-decoration: none;
}
.podfs-fs-back:hover { background: rgba(128, 128, 128, .18); }
`;

function useStyles(): void {
  useEffect(() => {
    if (document.getElementById("podfs-fs-styles")) return;
    const element = document.createElement("style");
    element.id = "podfs-fs-styles";
    element.textContent = CSS;
    document.head.appendChild(element);
  }, []);
}

export const FullScreenBrowser = observer(function FullScreenBrowser(): JSX.Element | null {
  useStyles();
  const target = viewer.target;

  useEffect(() => {
    if (!target) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") viewer.close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target]);

  if (!target) return null;

  // Inside `.Drawer` when possible: keeps OpenLens from treating our clicks as
  // "outside the drawer" and closing everything.
  const host = viewer.host ?? document.body;

  return ReactDOM.createPortal(
    <div
      className="podfs-fs-backdrop"
      data-testid="podfs-fullscreen"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) viewer.close();
      }}
    >
      <div className="podfs-fs-panel">
        <div className="podfs-fs-header">
          <span className="podfs-fs-title">文件管理</span>
          <span className="podfs-fs-sub">
            {target.namespace}/{target.pod}
            {target.container ? ` · ${target.container}` : ""}
          </span>
          <a
            className="podfs-fs-back"
            data-testid="podfs-fullscreen-back"
            href="#"
            title="关闭（Esc）"
            aria-label="关闭"
            onClick={(event) => {
              event.preventDefault();
              viewer.close();
            }}
          >
            ✕
          </a>
        </div>
        <div className="podfs-fs-body">
          <FileBrowser
            key={`${target.namespace}/${target.pod}/${target.container ?? ""}`}
            namespace={target.namespace}
            podName={target.pod}
            containers={target.containers}
            initialContainer={target.container}
          />
        </div>
      </div>
    </div>,
    host,
  ) as unknown as JSX.Element;
});

/**
 * Portal helper: rendered by the details item so the viewer exists while the
 * drawer is open. Wrapped in `observer` so it reacts to `viewer.target`.
 */
export const FullScreenBrowserPortal = observer(function FullScreenBrowserPortal(): JSX.Element | null {
  return viewer.target ? <FullScreenBrowser /> : null;
});
