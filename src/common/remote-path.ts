/** POSIX path helpers — remote container paths are always POSIX, even on Windows. */

export function normalizeDir(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "/";

  const absolute = raw.startsWith("/");
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const joined = parts.join("/");
  if (absolute) return "/" + joined;
  return joined || ".";
}

export function joinPath(dir: string, name: string): string {
  const base = normalizeDir(dir);
  if (name.startsWith("/")) return normalizeDir(name);
  if (base === "/") return "/" + name;
  return base + "/" + name;
}

export function dirname(path: string): string {
  const normalized = normalizeDir(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizeDir(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** Breadcrumb segments from root down to `dir`. */
export function breadcrumbs(dir: string): { name: string; path: string }[] {
  const normalized = normalizeDir(dir);
  const result: { name: string; path: string }[] = [{ name: "/", path: "/" }];
  if (normalized === "/") return result;

  let acc = "";
  for (const segment of normalized.split("/")) {
    if (!segment) continue;
    acc += "/" + segment;
    result.push({ name: segment, path: acc });
  }
  return result;
}

/** Reject names that cannot be used as a single path segment. */
export function validateEntryName(name: string): string | undefined {
  const value = (name ?? "").trim();
  if (!value) return "名称不能为空";
  if (value === "." || value === "..") return "名称不合法";
  if (value.includes("/")) return "名称不能包含 /";
  if (value.includes("\0")) return "名称包含非法字符";
  if (Buffer.byteLength(value, "utf8") > 255) return "名称过长（上限 255 字节）";
  return undefined;
}
