import { Main } from "@k8slens/extensions";

import { CHANNELS, type ProgressEvent } from "../common/types";
import type { PodFsService } from "./pod-fs";

/**
 * Per-extension IPC bridge. Lens isolates channels per extension and disposes
 * the handlers when the extension is deactivated.
 */
export class IpcMain extends Main.Ipc {
  private static current?: IpcMain;

  private static service?: PodFsService;


  constructor(extension: Main.LensExtension) {
    super(extension);
    IpcMain.current = this;

    const service = (): PodFsService => {
      if (!IpcMain.service) throw new Error("文件管理服务尚未初始化");
      return IpcMain.service;
    };


    this.handle(CHANNELS.probe, async (_event: unknown, request: any) => service().probe(request));
    this.handle(CHANNELS.list, async (_event: unknown, request: any) => service().list(request));
    this.handle(CHANNELS.stat, async (_event: unknown, request: any) => service().stat(request));
    this.handle(CHANNELS.rename, async (_event: unknown, request: any) => service().rename(request));
    this.handle(CHANNELS.mkdir, async (_event: unknown, request: any) => service().mkdir(request));
    this.handle(CHANNELS.remove, async (_event: unknown, request: any) => service().remove(request));
    this.handle(CHANNELS.upload, async (_event: unknown, request: any) => service().upload(request));
    this.handle(CHANNELS.download, async (_event: unknown, request: any) => service().download(request));
    this.handle(CHANNELS.cancel, async (_event: unknown, taskId: string) => service().cancel(taskId));
  }

  static create(extension: Main.LensExtension, service: PodFsService): IpcMain | undefined {
    IpcMain.service = service;
    const factory = IpcMain as unknown as { createInstance?: (ext: Main.LensExtension) => IpcMain };
    if (typeof factory.createInstance === "function") {
      return factory.createInstance(extension);
    }
    return new IpcMain(extension);
  }

  static emitProgress(event: ProgressEvent): void {
    try {
      IpcMain.current?.broadcast(CHANNELS.progress, event);
    } catch {
      // renderer not ready / extension deactivating — ignore
    }
  }
}
