import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType, type ObjectLookup } from './objects.ts';

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = asBuffer(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packChecksum(pack: Uint8Array): string {
  const buffer = asBuffer(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = asBuffer(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly declaredCount: number;
  readonly checksumOk: boolean;
}

export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const checksumOk = buffer.subarray(trailerStart).toString('hex') === createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');

  type Pending = {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
  };
  const entries: Pending[] = [];
  const byOffset = new Map<number, Pending>();
  let cursor = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const offset = cursor;
    const size = readVarintSize(buffer, cursor);
    const typeCode = (size.first >> 4) & 0x7;
    cursor = size.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      const ofs = readOfsDeltaBase(buffer, cursor);
      baseOffset = offset - ofs.baseOffset;
      cursor = ofs.next;
    } else if (typeCode === 7) {
      if (cursor + 20 > buffer.length) throw new Error('ref-delta base oid is truncated');
      baseOid = buffer.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
    }
    const inflated = inflateAt(buffer, cursor);
    cursor = inflated.next;
    const entry: Pending = { offset, typeCode, size: size.size, data: inflated.data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(offset, entry);
  }

  const objects = new Map<string, GitObject>();

  const resolve = (entry: Pending): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const type = CODE_TYPE[entry.typeCode]!;
      const oid = hashObject(type, entry.data);
      const object: GitObject = { type, data: entry.data, oid };
      entry.resolved = object;
      objects.set(oid, object);
      return object;
    }
    let base: GitObject | undefined;
    if (entry.typeCode === 6) {
      const parent = byOffset.get(entry.baseOffset ?? -1);
      if (!parent) throw new Error(`ofs-delta base at ${entry.baseOffset} is missing`);
      base = resolve(parent);
    } else if (entry.typeCode === 7) {
      const oid = entry.baseOid!;
      const already = objects.get(oid) ?? options.resolveBase?.(oid);
      if (already) base = already;
      else {
        throw new Error(`ref-delta base ${oid} is missing`);
      }
    } else {
      throw new Error(`unknown pack type ${entry.typeCode}`);
    }
    const data = applyDelta(base.data, entry.data);
    const object: GitObject = { type: base.type, data, oid: hashObject(base.type, data) };
    entry.resolved = object;
    objects.set(object.oid, object);
    return object;
  };

  for (const entry of entries) resolve(entry);
  return { objects, declaredCount, checksumOk };
}
