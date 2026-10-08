import test from "node:test";
import assert from "node:assert/strict";
import { validateEdrpou, validateUAIban, normalizeUAIban, normalizeEdrpou } from "../../src/lib/validators";

test("validateEdrpou should accept valid 8-digit EDRPOU", () => {
  assert.equal(validateEdrpou("12345678"), true);
});

test("validateEdrpou should accept valid 10-digit EDRPOU", () => {
  assert.equal(validateEdrpou("1234567890"), true);
});

test("validateEdrpou should reject invalid length EDRPOU", () => {
  assert.equal(validateEdrpou("1234567"), false);
  assert.equal(validateEdrpou("12345678901"), false);
});

test("validateEdrpou should accept 9-digit EDRPOU", () => {
  // 9 digits is valid per the regex pattern
  assert.equal(validateEdrpou("123456789"), true);
});

test("validateEdrpou should reject non-numeric EDRPOU", () => {
  assert.equal(validateEdrpou("1234567a"), false);
  assert.equal(validateEdrpou("abcdefgh"), false);
});

test("validateUAIban should accept valid UA IBAN", () => {
  assert.equal(validateUAIban("UA213996220000026007233566001"), true);
});

test("validateUAIban should accept valid UA IBAN with spaces", () => {
  assert.equal(validateUAIban("UA21 399622 00000 26007 23356 6001"), true);
});

test("validateUAIban should reject invalid IBAN length", () => {
  assert.equal(validateUAIban("UA21399622000002600723356600"), false);
});

test("validateUAIban should reject non-UA IBAN", () => {
  assert.equal(validateUAIban("GB29NWBK60161331926819"), false);
});

test("normalizeUAIban should remove spaces and uppercase", () => {
  assert.equal(normalizeUAIban("ua21 399622 00000 26007 23356 6001"), "UA213996220000026007233566001");
});

test("normalizeEdrpou should strip spaces, dashes and dots", () => {
  assert.equal(normalizeEdrpou("123 456-78"), "12345678");
  assert.equal(normalizeEdrpou(" 1234567890 "), "1234567890");
  assert.equal(normalizeEdrpou("12.34.56.78"), "12345678");
});

test("normalizeEdrpou should leave digit-only input unchanged", () => {
  assert.equal(normalizeEdrpou("12345678"), "12345678");
});

test("normalizeUAIban should handle already normalized IBAN", () => {
  assert.equal(normalizeUAIban("UA213996220000026007233566001"), "UA213996220000026007233566001");
});
