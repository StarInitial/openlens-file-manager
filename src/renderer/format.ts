import type { FileKind } from "../common/types";

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatTime(ms: number): string {
  if (!ms) return "-";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function kindIcon(kind: FileKind): string {
  switch (kind) {
    case "dir":
      return "folder";
    case "symlink":
      return "link";
    case "file":
      return "insert_drive_file";
    default:
      return "help_outline";
  }
}

export function kindLabel(kind: FileKind): string {
  switch (kind) {
    case "dir":
      return "目录";
    case "symlink":
      return "符号链接";
    case "file":
      return "普通文件";
    default:
      return "特殊文件";
  }
}
