/**
 * Git pkt-line framing, written from gitprotocol-common and git's pkt-line.h.
 *
 * A packet is four ASCII hex digits of total length, then that many bytes minus
 * those four. The length counts the header. Special lengths carry no payload:
 * 0000 flush, 0001 delim (protocol v2), 0002 response-end (protocol v2).
 * 0003 is not a packet. The largest legal packet is 65520 bytes, git's
 * LARGE_PACKET_MAX, which leaves 65516 bytes of payload.
 *
 * This codec does not strip a trailing LF. When a text line includes one, the
 * LF is part of the payload and part of the length.
 */

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type PktLine =
  | { readonly kind: "data"; readonly payload: Uint8Array }
  | { readonly kind: "flush" }
  | { readonly kind: "delim" }
  | { readonly kind: "response-end" };

export class PktLineError extends Error {
  readonly code: "too-long" | "header" | "truncated" | "after-end";

  constructor(code: PktLineError["code"], message: string) {
    super(message);
    this.name = "PktLineError";
    this.code = code;
  }
}

function asBytes(payload: string | Uint8Array): Uint8Array {
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return payload;
}

function headerOf(total: number): Uint8Array {
  const hex = total.toString(16).padStart(4, "0");
  return Uint8Array.from(hex, (ch) => ch.charCodeAt(0));
}

/** Encode one data packet. Rejects a payload that would exceed LARGE_PACKET_MAX. */
export function encodeData(payload: string | Uint8Array): Uint8Array {
  const body = asBytes(payload);
  if (body.byteLength > PKT_LINE_MAX_PAYLOAD) {
    throw new PktLineError(
      "too-long",
      `pkt-line payload is ${body.byteLength} bytes; maximum is ${PKT_LINE_MAX_PAYLOAD}`,
    );
  }
  const out = new Uint8Array(body.byteLength + 4);
  out.set(headerOf(out.byteLength), 0);
  out.set(body, 4);
  return out;
}

export function encodeFlush(): Uint8Array {
  return Uint8Array.from([0x30, 0x30, 0x30, 0x30]);
}

export function encodeDelim(): Uint8Array {
  return Uint8Array.from([0x30, 0x30, 0x30, 0x31]);
}

export function encodeResponseEnd(): Uint8Array {
  return Uint8Array.from([0x30, 0x30, 0x30, 0x32]);
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return -1;
}

/**
 * Incremental decoder. `next` returns one complete packet or null when it needs
 * more bytes. `finish` marks the stream ended; a partial packet then throws
 * instead of being dropped.
 *
 * ponytail: one contiguous buffer, compacted when the consumed prefix grows.
 * Fine for a single request body. A multi-gigabyte stream would want a chunk
 * queue so compacting does not copy the tail.
 */
export class PktLineDecoder {
  private buf = new Uint8Array(0);
  private pos = 0;
  private ended = false;

  push(chunk: Uint8Array): void {
    if (this.ended) {
      throw new PktLineError("after-end", "pkt-line decoder received bytes after finish()");
    }
    if (chunk.byteLength === 0) return;
    this.compact();
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;
  }

  finish(): void {
    this.ended = true;
  }

  get bufferedBytes(): number {
    return this.buf.byteLength - this.pos;
  }

  next(): PktLine | null {
    const available = this.bufferedBytes;
    if (available < 4) {
      if (this.ended && available > 0) {
        throw new PktLineError("truncated", `truncated pkt-line: ${available} trailing byte(s)`);
      }
      return null;
    }
    const length = this.readLength();
    if (length === 0) {
      this.pos += 4;
      return { kind: "flush" };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: "delim" };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: "response-end" };
    }
    if (length === 3) {
      throw new PktLineError("header", "invalid pkt-line length 0003");
    }
    if (length > PKT_LINE_MAX) {
      throw new PktLineError("too-long", `pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    }
    if (available < length) {
      if (this.ended) {
        throw new PktLineError(
          "truncated",
          `truncated pkt-line: ${length} announced, ${available} available`,
        );
      }
      return null;
    }
    const payload = this.buf.slice(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: "data", payload };
  }

  private readLength(): number {
    let length = 0;
    for (let i = 0; i < 4; i += 1) {
      const digit = hexValue(this.buf[this.pos + i]);
      if (digit < 0) {
        const header = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + 4));
        throw new PktLineError("header", `invalid pkt-line length ${JSON.stringify(header)}`);
      }
      length = length * 16 + digit;
    }
    return length;
  }

  private compact(): void {
    if (this.pos === 0) return;
    this.buf = this.buf.subarray(this.pos);
    this.pos = 0;
  }
}

/** Decode a finished buffer. Throws if the buffer ends inside a packet. */
export function decodeAll(bytes: Uint8Array): PktLine[] {
  const decoder = new PktLineDecoder();
  decoder.push(bytes);
  decoder.finish();
  const packets: PktLine[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) return packets;
    packets.push(packet);
  }
}
