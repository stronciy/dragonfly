"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRequestId = getRequestId;
exports.ok = ok;
exports.fail = fail;
const server_1 = require("next/server");
const errors_1 = require("./errors");
function getRequestId(req) {
    var _a;
    return (_a = req.headers.get("x-request-id")) !== null && _a !== void 0 ? _a : crypto.randomUUID();
}
function ok(req, data, init) {
    var _a, _b;
    const requestId = getRequestId(req);
    const body = {
        success: true,
        code: "SUCCESS",
        data,
        message: (_a = init === null || init === void 0 ? void 0 : init.message) !== null && _a !== void 0 ? _a : "OK",
        timestamp: new Date().toISOString(),
        requestId,
    };
    return server_1.NextResponse.json(body, { status: (_b = init === null || init === void 0 ? void 0 : init.status) !== null && _b !== void 0 ? _b : 200, headers: init === null || init === void 0 ? void 0 : init.headers });
}
function fail(req, err) {
    const requestId = getRequestId(req);
    const apiErr = (0, errors_1.asApiError)(err);
    const body = {
        success: false,
        code: apiErr.code,
        error: {
            type: apiErr.name || "Error",
            details: apiErr.details,
        },
        message: apiErr.message,
        timestamp: new Date().toISOString(),
        requestId,
    };
    if (process.env.NODE_ENV !== "production" && apiErr.code === "VALIDATION_ERROR") {
        console.warn(`[api] ${req.method} ${new URL(req.url).pathname} ${apiErr.status} ${apiErr.code} requestId=${requestId}`, apiErr.details);
    }
    return server_1.NextResponse.json(body, { status: apiErr.status });
}
