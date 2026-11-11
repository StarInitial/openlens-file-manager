import { Readable } from "node:stream";

/**
 * Minimal ustar writer/reader.
 *
 * We deliberately avoid a tar dependency: the extension travels as a `.tgz`
 * that OpenLens unpacks without installing node_modules, so fewer runtime
 * dependencies means fewer ways to break.
 */

const BLOCK = 512;

export interface PackEntry {
  /** Path inside the archive (no leading slash). */
  name: string;
  type: "file" | "dir";
  size?: number;
  mode?: number;
  mtimeMs?: number;
  content?: Readable;
}

function writeAscii(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const text = Math.max(0, Math.floor(value)).toString(8);
  const padded = text.padStart(length - 1, "0").slice(-(length - 1));
  buf.write(padded + "\0", offset, length, "ascii");
}

function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name, "utf8") <= 100) return { name, prefix: "" };
  for (let i = name.length - 1; i > 0; i -= 1) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const suffix = name.slice(i + 1);
    if (!suffix) continue;
    if (Buffer.byteLength(suffix, "utf8") > 100) continue;
    if (Buffer.byteLength(prefix, "utf8") > 155) continue;
    return { name: suffix, prefix };
  }
  throw new Error(`路径过长，无法打包：${name}`);
}

function buildHeader(entry: PackEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const isDir = entry.type === "dir";
  let name = entry.name.replace(/^\.?\//, "");
  if (isDir && !name.endsWith("/")) name += "/";

  const split = splitName(name);
  writeAscii(header, 0, 100, split.name);
  writeOctal(header, 100, 8, entry.mode ?? (isDir ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor((entry.mtimeMs ?? Date.now()) / 1000));
  writeAscii(header, 148, 8, "        "); // checksum placeholder
  writeAscii(header, 156, 1, isDir ? "5" : "0");
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 345, 155, split.prefix);

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function padding(length: number): Buffer {
  const remainder = length % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

/** Build a tar stream from a sequence of entries. */
export function createTarStream(entries: AsyncIterable<PackEntry>): Readable {
  const generator = async function* (): AsyncGenerator<Buffer> {
    for await (const entry of entries) {
      const size = entry.type === "file" ? (entry.size ?? 0) : 0;
      yield buildHeader(entry, size);

      if (entry.type === "file" && size > 0 && entry.content) {
        let written = 0;
        for await (const chunk of entry.content) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          written += buffer.length;
          yield buffer;
        }
        if (written !== size) {
          throw new Error(`打包 ${entry.name} 时大小不一致（声明 ${size}，实际 ${written}）`);
        }
        const pad = padding(written);
        if (pad.length > 0) yield pad;
      }
    }
    // two zero blocks terminate the archive
    yield Buffer.alloc(BLOCK * 2, 0);
  };

  return Readable.from(generator());
}

class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;

  private buffered: Buffer = Buffer.alloc(0);

  private finished = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Buffer | undefined> {
    while (this.buffered.length < length) {
      if (this.finished) {
        if (this.buffered.length === 0) return undefined;
        const remainder = this.buffered;
        this.buffered = Buffer.alloc(0);
        return remainder;
      }
      const { value, done } = await this.iterator.next();
      if (done) {
        this.finished = true;
        continue;
      }
      this.buffered = this.buffered.length === 0 ? value : Buffer.concat([this.buffered, value]);
    }
    const head = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return head;
  }

  /** Remaining bytes of the current archive stream, capped at `limit`. */
  remainder(limit: number): Readable {
    const self = this;
    const generator = async function* (): AsyncGenerator<Buffer> {
      let sent = 0;
      if (self.buffered.length > 0) {
        const chunk = self.buffered.subarray(0, limit);
        self.buffered = self.buffered.subarray(chunk.length);
        sent += chunk.length;
        yield chunk;
      }
      while (sent < limit && !self.finished) {
        const { value, done } = await self.iterator.next();
        if (done) {
          self.finished = true;
          break;
        }
        const room = limit - sent;
        const chunk = value.length > room ? value.subarray(0, room) : value;
        sent += chunk.length;
        yield chunk;
      }
    };
    return Readable.from(generator());
  }
}

export interface ExtractedFile {
  name: string;
  size: number;
  mode: number;
  mtimeMs: number;
  content: Readable;
}

function readHeaderFields(buffer: Buffer): { name: string; size: number; mode: number; mtimeMs: number; type: string } {
  const readString = (offset: number, length: number): string => {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
  };
  const readOctal = (offset: number, length: number): number => {
    const text = readString(offset, length).trim();
    return text ? parseInt(text, 8) : 0;
  };

  const prefix = readString(345, 155);
  const shortName = readString(0, 100);
  const name = prefix ? `${prefix}/${shortName}` : shortName;

  return {
    name,
    size: readOctal(124, 12),
    mode: readOctal(100, 8),
    mtimeMs: readOctal(136, 12) * 1000,
    type: readString(156, 1) || "0",
  };
}

/**
 * Read the first regular file out of a tar stream produced by `tar -cf -`.
 * Extra headers (GNU longname / pax) are skipped transparently.
 */
export async function readFirstFileEntry(source: Readable): Promise<ExtractedFile | undefined> {
  const reader = new ByteReader(source as unknown as AsyncIterable<Buffer>);

  for (let guard = 0; guard < 16; guard += 1) {
    const block = await reader.read(BLOCK);
    if (!block || block.length < BLOCK) return undefined;
    if (block.every((byte) => byte === 0)) return undefined;

    const fields = readHeaderFields(block);

    // GNU longname ('L') / pax ('x'): the payload is the real name, skip it.
    if (fields.type === "L" || fields.type === "x" || fields.type === "K") {
      const skipped = fields.size + (BLOCK - (fields.size % BLOCK)) % BLOCK;
      await reader.read(skipped);
      continue;
    }

    if (fields.type !== "0" && fields.type !== "") return undefined;
    return {
      name: fields.name,
      size: fields.size,
      mode: fields.mode,
      mtimeMs: fields.mtimeMs,
      content: reader.remainder(fields.size),
    };
  }
  return undefined;
}
