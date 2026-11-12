import test from "node:test";
import assert from "node:assert/strict";
import { detectMimeType } from "../../src/lib/uploads";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

test("заявлений тип зберігається", () => {
  assert.equal(detectMimeType("image/png", "x.bin", jpeg), "image/png");
});

test("порожній або octet-stream тип визначається за розширенням", () => {
  assert.equal(detectMimeType("", "field.JPG", Buffer.alloc(4)), "image/jpeg");
  assert.equal(detectMimeType("application/octet-stream", "clip.mp4", Buffer.alloc(4)), "video/mp4");
});

test("без розширення тип визначається за сигнатурою файлу", () => {
  assert.equal(detectMimeType("", "photo", jpeg), "image/jpeg");
  assert.equal(detectMimeType("", "photo", png), "image/png");
});

test("невідомий файл лишається application/octet-stream", () => {
  assert.equal(detectMimeType("", "data.bin", Buffer.from([1, 2, 3])), "application/octet-stream");
});
