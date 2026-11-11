import { Renderer } from "@k8slens/extensions";

import { CHANNELS, type ProgressEvent } from "../common/types";

/** Child class required by the host IPC API. */
export class RendererIpc extends Renderer.Ipc {}

let instance: RendererIpc | undefined;

export function initRendererIpc(extension: Renderer.LensExtension): void {
  const factory = RendererIpc as unknown as { createInstance?: (ext: Renderer.LensExtension) => RendererIpc };
  instance = typeof factory.createInstance === "function" ? factory.createInstance(extension) : undefined;
}

export async function invoke<T>(channel: keyof typeof CHANNELS, ...args: unknown[]): Promise<T> {
  if (!instance) throw new Error("扩展 IPC 尚未初始化");
  return (instance as unknown as { invoke: (name: string, ...rest: unknown[]) => Promise<T> }).invoke(
    CHANNELS[channel],
    ...args,
  );
}

export function onProgress(listener: (event: ProgressEvent) => void): () => void {
  if (!instance) return () => undefined;
  const bus = instance as unknown as {
    listen?: (channel: string, handler: (event: unknown, payload: ProgressEvent) => void) => () => void;
  };
  return bus.listen?.(CHANNELS.progress, (_event, payload) => listener(payload)) ?? (() => undefined);
}
