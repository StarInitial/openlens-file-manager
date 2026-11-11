import React from "react";
import { observer } from "mobx-react";
import { Renderer } from "@k8slens/extensions";

import { FullScreenBrowser } from "./full-screen-browser";
import { Icon } from "./ui";
import { targetFromPod, viewer } from "./viewer-state";

const Component: Record<string, any> = ((Renderer as unknown as { Component?: Record<string, any> }).Component) ?? {};

function notifyError(message: string): void {
  try {
    const notifications = Component.Notifications;
    if (notifications?.error) {
      notifications.error(message);
      return;
    }
  } catch {
    // fall through to console
  }
  console.error(`[pod-file-manager] ${message}`);
}

function PodFilesToolbarItemBase(props: { object?: any; toolbar?: boolean }): JSX.Element | null {
  const pod = props.object;
  // Lens renders the same registered item in two places: the Pods list row kebab
  // menu (`<KubeObjectMenu object={pod} />`) and the Pod details header
  // (`<KubeObjectMenu object={pod} toolbar />`). Only the header should offer the
  // file manager, so anything without `toolbar` stays invisible.
  if (!pod || props.toolbar !== true) return null;

  const open = () => {
    const target = targetFromPod(pod);
    if (!target) {
      notifyError("无法读取 Pod 的 namespace/name，暂时无法打开文件管理。");
      return;
    }
    console.info("[pod-file-manager] opening full-screen viewer", target);
    viewer.open(target);
  };

  const content = (
    <>
      <Icon material="folder_open" tooltip="文件管理" interactive={props.toolbar} />
      <span className="title">文件管理</span>
    </>
  );

  const MenuItem: any = Component.MenuItem;

  const button = MenuItem ? (
    <MenuItem onClick={open}>{content}</MenuItem>
  ) : (
    <a
      href="#"
      data-testid="podfs-toolbar-item"
      title="文件管理"
      style={{ color: "inherit", display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
    >
      {content}
    </a>
  );

  // The overlay is rendered from this very component: whatever frame and slot the
  // toolbar icon is mounted in, the portal宿主 is guaranteed to be there. (A
  // status-bar host turned out to be unreliable — clicking did nothing.)
  return (
    <>
      {button}
      <FullScreenBrowser />
    </>
  );
}

export const PodFilesToolbarItem = observer(PodFilesToolbarItemBase);
