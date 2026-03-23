"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEdrpou = validateEdrpou;
exports.normalizeUAIban = normalizeUAIban;
exports.validateUAIban = validateUAIban;
function validateEdrpou(value) {
    return /^\d{8,10}$/.test(value);
}
function normalizeUAIban(value) {
    return value.replace(/\s+/g, "").toUpperCase();
}
function validateUAIban(value) {
    const iban = normalizeUAIban(value);
    if (!/^UA\d{27}$/.test(iban))
        return false;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
        const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
        for (const d of digits) {
            remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
        }
    }
    return remainder === 1;
}
