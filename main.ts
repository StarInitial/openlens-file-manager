import { app, dialog } from "electron";
import { homedir } from "node:os";
import { Main } from "@k8slens/extensions";

import { PodFsService } from "./src/main/pod-fs";
import { IpcMain } from "./src/main/ipc";
import { readSettings } from "./src/main/prefs";

export default class PodFileManagerMain extends Main.LensExtension {
  async onActivate(): Promise<void> {
    const userDataPath = app.getPath("userData");

    const service = new PodFsService({
      userDataPath,
      homeDir: homedir(),
      getSettings: () => readSettings(userDataPath),
      onProgress: (event) => IpcMain.emitProgress(event),
      pickSavePath: async (suggestedName) => {
        const result = await dialog.showSaveDialog({
          title: "保存到本地",
          defaultPath: suggestedName,
          buttonLabel: "保存",
        });
        return result.canceled ? undefined : result.filePath;
      },
    });

    IpcMain.create(this, service);
  }

  async onDeactivate(): Promise<void> {
    // Nothing to release: every exec session is tied to a request promise.
  }
}
