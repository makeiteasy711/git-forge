import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PKT_LINE_MAX,
  PKT_LINE_MAX_PAYLOAD,
  PktLineDecoder,
  PktLineError,
  decodeAll,
  encodeData,
  encodeDelim,
  encodeFlush,
  encodeResponseEnd,
} from "./pkt-line.ts";

const text = new TextDecoder();

test("data packet length counts the 4-byte header and keeps a trailing LF", () => {
  const encoded = encodeData("hello\n");
  assert.equal(text.decode(encoded.subarray(0, 4)), "000a");
  assert.equal(encoded.byteLength, 10);
  const [packet] = decodeAll(encoded);
  assert.equal(packet.kind, "data");
  if (packet.kind !== "data") return;
  assert.equal(text.decode(packet.payload), "hello\n");
});

test("flush, delim, and response-end are the four-byte special packets", () => {
  const encoded = new Uint8Array([
    ...encodeFlush(),
    ...encodeDelim(),
    ...encodeResponseEnd(),
    ...encodeData(""),
  ]);
  assert.equal(text.decode(encoded), "0000000100020004");
  assert.deepEqual(
    decodeAll(encoded).map((packet) => packet.kind),
    ["flush", "delim", "response-end", "data"],
  );
  const empty = decodeAll(encoded)[3];
  assert.equal(empty.kind, "data");
  if (empty.kind === "data") assert.equal(empty.payload.byteLength, 0);
});

test("binary payload round-trips, including NUL, and uppercase hex is accepted", () => {
  const payload = Uint8Array.from([0x00, 0xff, 0x0a, 0x41]);
  const [binary] = decodeAll(encodeData(payload));
  assert.equal(binary.kind, "data");
  if (binary.kind !== "data") return;
  assert.deepEqual(binary.payload, payload);

  const encoded = encodeData("hello\n");
  assert.equal(text.decode(encoded.subarray(0, 4)), "000a");
  const upper = encoded.slice();
  upper[3] = 0x41;
  const [packet] = decodeAll(upper);
  assert.equal(packet.kind, "data");
  if (packet.kind !== "data") return;
  assert.equal(text.decode(packet.payload), "hello\n");
});

test("a packet may be split across pushes and is not emitted early", () => {
  const encoded = encodeData("abcd");
  const decoder = new PktLineDecoder();
  decoder.push(encoded.subarray(0, 3));
  assert.equal(decoder.next(), null);
  decoder.push(encoded.subarray(3, 6));
  assert.equal(decoder.next(), null);
  decoder.push(encoded.subarray(6));
  const packet = decoder.next();
  assert.equal(packet?.kind, "data");
  if (packet?.kind === "data") assert.equal(text.decode(packet.payload), "abcd");
  assert.equal(decoder.next(), null);
});

test("0003, a non-hex header, an oversize length, and a truncated finish are errors", () => {
  assert.throws(() => decodeAll(Uint8Array.from([0x30, 0x30, 0x30, 0x33])), (error: unknown) => {
    return error instanceof PktLineError && error.code === "header";
  });
  assert.throws(() => decodeAll(new TextEncoder().encode("zzzz")), (error: unknown) => {
    return error instanceof PktLineError && error.code === "header";
  });
  const tooBig = new TextEncoder().encode("fff1");
  assert.equal(0xfff1 > PKT_LINE_MAX, true);
  assert.throws(() => decodeAll(tooBig), (error: unknown) => {
    return error instanceof PktLineError && error.code === "too-long";
  });
  const partial = new PktLineDecoder();
  partial.push(new TextEncoder().encode("0008abc"));
  partial.finish();
  assert.throws(() => partial.next(), (error: unknown) => {
    return error instanceof PktLineError && error.code === "truncated";
  });
});

test("the largest legal payload encodes and one extra byte is refused", () => {
  const max = new Uint8Array(PKT_LINE_MAX_PAYLOAD);
  max[0] = 0x58;
  max[max.byteLength - 1] = 0x59;
  const encoded = encodeData(max);
  assert.equal(encoded.byteLength, PKT_LINE_MAX);
  assert.equal(text.decode(encoded.subarray(0, 4)), "fff0");
  const [packet] = decodeAll(encoded);
  assert.equal(packet.kind, "data");
  if (packet.kind === "data") {
    assert.equal(packet.payload.byteLength, PKT_LINE_MAX_PAYLOAD);
    assert.equal(packet.payload[0], 0x58);
    assert.equal(packet.payload[PKT_LINE_MAX_PAYLOAD - 1], 0x59);
  }
  assert.throws(() => encodeData(new Uint8Array(PKT_LINE_MAX_PAYLOAD + 1)), PktLineError);
});
