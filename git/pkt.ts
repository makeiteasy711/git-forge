export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

export class PktLineDecoder {
  private leftover = Buffer.alloc(0);
  private ended = false;

  push(chunk: Uint8Array): void {
    const buf = Buffer.from(chunk);
    this.leftover = this.leftover.length === 0 ? buf : Buffer.concat([this.leftover, buf]);
  }

  next(): GitPacket | null {
    if (this.leftover.length < 4) return null;
    const header = this.leftover.subarray(0, 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    }
    const length = parseInt(header, 16);
    if (length === 0) {
      this.leftover = this.leftover.subarray(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.leftover = this.leftover.subarray(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.leftover = this.leftover.subarray(4);
      return { kind: 'response-end' };
    }
    if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
    if (this.leftover.length < length) return null;
    const payload = this.leftover.subarray(4, length);
    this.leftover = this.leftover.subarray(length);
    return { kind: 'data', payload: Buffer.from(payload) };
  }

  finish(): GitPacket[] {
    this.ended = true;
    const out: GitPacket[] = [];
    for (;;) {
      if (this.leftover.length === 0) return out;
      const packet = this.next();
      if (packet === null) {
        if (this.leftover.length > 0) throw new Error('truncated pkt-line');
        return out;
      }
      out.push(packet);
    }
  }

  decodeAll(bytes: Uint8Array): GitPacket[] {
    this.push(bytes);
    const packets: GitPacket[] = [];
    for (let p = this.next(); p !== null; p = this.next()) packets.push(p);
    if (this.leftover.length > 0) {
      // Tolerate a trailing pack after a flush: caller splits.
    }
    return packets;
  }
}

export function decodePktLines(bytes: Uint8Array): { packets: GitPacket[]; rest: Buffer } {
  const decoder = new PktLineDecoder();
  decoder.push(bytes);
  const packets: GitPacket[] = [];
  let consumed = 0;
  const total = Buffer.from(bytes);
  let offset = 0;
  while (offset + 4 <= total.length) {
    const header = total.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      const kind = length === 0 ? 'flush' : length === 1 ? 'delim' : 'response-end';
      packets.push({ kind } as GitPacket);
      offset += 4;
      if (kind === 'flush') {
        return { packets, rest: total.subarray(offset) };
      }
      continue;
    }
    if (length < 4 || offset + length > total.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(total.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  consumed = offset;
  return { packets, rest: total.subarray(consumed) };
}

export function packetText(packet: GitPacket): string | null {
  if (packet.kind !== 'data') return null;
  return packet.payload.toString('utf8');
}

export function sidebandFrames(band: 1 | 2 | 3, data: Uint8Array, maxData = PKT_LINE_MAX_PAYLOAD - 1): Buffer {
  const source = Buffer.from(data);
  if (source.length === 0) {
    return encodePktLine(Buffer.from([band]));
  }
  const parts: Buffer[] = [];
  for (let offset = 0; offset < source.length; ) {
    const n = Math.min(maxData, source.length - offset);
    const chunk = Buffer.allocUnsafe(1 + n);
    chunk[0] = band;
    source.copy(chunk, 1, offset, offset + n);
    parts.push(encodePktLine(chunk));
    offset += n;
  }
  return Buffer.concat(parts);
}
