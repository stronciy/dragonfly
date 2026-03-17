"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.verifyAccessToken = verifyAccessToken;
exports.verifyRefreshToken = verifyRefreshToken;
exports.sha256 = sha256;
const jose_1 = require("jose");
function getSecret(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`${name} is required`);
    return new TextEncoder().encode(value);
}
async function signAccessToken(payload) {
    return new jose_1.SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(getSecret("JWT_ACCESS_SECRET"));
}
async function signRefreshToken(payload) {
    return new jose_1.SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(getSecret("JWT_REFRESH_SECRET"));
}
async function verifyAccessToken(token) {
    const { payload } = await (0, jose_1.jwtVerify)(token, getSecret("JWT_ACCESS_SECRET"));
    return payload;
}
async function verifyRefreshToken(token) {
    const { payload } = await (0, jose_1.jwtVerify)(token, getSecret("JWT_REFRESH_SECRET"));
    return payload;
}
async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Buffer.from(digest).toString("hex");
}
