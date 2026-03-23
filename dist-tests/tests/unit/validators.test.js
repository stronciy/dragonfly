"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const validators_1 = require("../../src/lib/validators");
(0, node_test_1.default)("validateEdrpou should accept valid 8-digit EDRPOU", () => {
    strict_1.default.equal((0, validators_1.validateEdrpou)("12345678"), true);
});
(0, node_test_1.default)("validateEdrpou should accept valid 10-digit EDRPOU", () => {
    strict_1.default.equal((0, validators_1.validateEdrpou)("1234567890"), true);
});
(0, node_test_1.default)("validateEdrpou should reject invalid length EDRPOU", () => {
    strict_1.default.equal((0, validators_1.validateEdrpou)("1234567"), false);
    strict_1.default.equal((0, validators_1.validateEdrpou)("12345678901"), false);
});
(0, node_test_1.default)("validateEdrpou should accept 9-digit EDRPOU", () => {
    // 9 digits is valid per the regex pattern
    strict_1.default.equal((0, validators_1.validateEdrpou)("123456789"), true);
});
(0, node_test_1.default)("validateEdrpou should reject non-numeric EDRPOU", () => {
    strict_1.default.equal((0, validators_1.validateEdrpou)("1234567a"), false);
    strict_1.default.equal((0, validators_1.validateEdrpou)("abcdefgh"), false);
});
(0, node_test_1.default)("validateUAIban should accept valid UA IBAN", () => {
    strict_1.default.equal((0, validators_1.validateUAIban)("UA213996220000026007233566001"), true);
});
(0, node_test_1.default)("validateUAIban should accept valid UA IBAN with spaces", () => {
    strict_1.default.equal((0, validators_1.validateUAIban)("UA21 399622 00000 26007 23356 6001"), true);
});
(0, node_test_1.default)("validateUAIban should reject invalid IBAN length", () => {
    strict_1.default.equal((0, validators_1.validateUAIban)("UA21399622000002600723356600"), false);
});
(0, node_test_1.default)("validateUAIban should reject non-UA IBAN", () => {
    strict_1.default.equal((0, validators_1.validateUAIban)("GB29NWBK60161331926819"), false);
});
(0, node_test_1.default)("normalizeUAIban should remove spaces and uppercase", () => {
    strict_1.default.equal((0, validators_1.normalizeUAIban)("ua21 399622 00000 26007 23356 6001"), "UA213996220000026007233566001");
});
(0, node_test_1.default)("normalizeUAIban should handle already normalized IBAN", () => {
    strict_1.default.equal((0, validators_1.normalizeUAIban)("UA213996220000026007233566001"), "UA213996220000026007233566001");
});
