import React from "react";
import { Renderer } from "@k8slens/extensions";

import { initRendererIpc } from "./src/renderer/ipc";
import { PodFilesToolbarItem } from "./src/renderer/pod-files-toolbar-item";

/**
 * The file manager has exactly ONE entry point: the folder icon in the Pod
 * details header. Clicking it paints a full-screen overlay through a portal, so
 * the Pods list and the details drawer keep their scroll position and state.
 *
 * The overlay is rendered by the toolbar item itself (not by a status bar item),
 * because the toolbar item is guaranteed to be mounted wherever the user clicks.
 */
export default class PodFileManagerRenderer extends Renderer.LensExtension {
  async onActivate(): Promise<void> {
    initRendererIpc(this);
  }

  /** Folder icon in the Pod details header: opens the full-screen viewer. */
  kubeObjectMenuItems = [
    {
      kind: "Pod",
      apiVersions: ["v1"],
      components: {
        MenuItem: (props: any) => <PodFilesToolbarItem {...props} />,
      },
    },
  ] as unknown as Renderer.LensExtension["kubeObjectMenuItems"];
}
