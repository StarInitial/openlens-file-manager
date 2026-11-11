import { action, makeObservable, observable } from "mobx";

export interface ViewerTarget {
  namespace: string;
  pod: string;
  containers: string[];
  container: string;
}

/**
 * Full-screen file viewer state.
 *
 * Deliberately NOT a routed cluster page: the viewer is painted on top of the
 * current route (portal to `document.body`), so the Pods list scroll position,
 * filters and the details drawer stay mounted and untouched. Closing the viewer
 * simply restores what the user was looking at.
 */
class ViewerState {
  target: ViewerTarget | undefined = undefined;

  /**
   * DOM node the overlay is portaled into.
   *
   * It MUST be (or be inside) the open `.Drawer`, because OpenLens' Drawer treats
   * a click as "outside" — and closes itself — when `event.target.closest(".Drawer")`
   * is empty. A portal into `document.body` therefore closed both the drawer and
   * this overlay as soon as the user clicked a row.
   */
  host: HTMLElement | undefined = undefined;

  constructor() {
    makeObservable(this, { target: observable, host: observable, open: action, close: action });
  }

  open(target: ViewerTarget): void {
    this.host = ViewerState.findDrawerHost();
    this.target = target;
  }

  close(): void {
    this.target = undefined;
    this.host = undefined;
  }

  isOpen(): boolean {
    return this.target !== undefined;
  }

  private static findDrawerHost(): HTMLElement | undefined {
    if (typeof document === "undefined") return undefined;
    const drawers = document.querySelectorAll<HTMLElement>(".Drawer");
    // The details drawer is the one currently open and rendered last.
    return drawers.length > 0 ? drawers[drawers.length - 1] : undefined;
  }
}

export const viewer = new ViewerState();

/** Build a viewer target from a Pod kube object. */
export function targetFromPod(pod: any): ViewerTarget | undefined {
  if (!pod) return undefined;
  const namespace: string = pod?.getNs?.() ?? pod?.metadata?.namespace ?? "";
  const name: string = pod?.getName?.() ?? pod?.metadata?.name ?? "";
  if (!namespace || !name) return undefined;

  const containers: string[] = (pod?.spec?.containers ?? [])
    .map((item: { name?: string }) => item.name ?? "")
    .filter(Boolean);
  const defaultContainer: string =
    pod?.metadata?.annotations?.["kubectl.kubernetes.io/default-container"] ?? containers[0] ?? "";

  return { namespace, pod: name, containers, container: defaultContainer };
}
