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
    const status = (_a = init === null || init === void 0 ? void 0 : init.status) !== null && _a !== void 0 ? _a : 200;
    const headers = new Headers(init === null || init === void 0 ? void 0 : init.headers);
    headers.set("x-request-id", requestId);
    if (status === 204 || status === 205) {
        return new server_1.NextResponse(null, { status, headers });
    }
    const body = {
        success: true,
        code: "SUCCESS",
        data,
        message: (_b = init === null || init === void 0 ? void 0 : init.message) !== null && _b !== void 0 ? _b : "OK",
        timestamp: new Date().toISOString(),
        requestId,
    };
    return server_1.NextResponse.json(body, { status, headers });
}
/**
 * Default retry-after seconds for retryable errors.
 * Clients can use this as a baseline for exponential backoff.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
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
    const headers = new Headers();
    // Add Retry-After header for retryable errors (503, 504, 429)
    if (apiErr instanceof errors_1.ApiError && apiErr.retryable) {
        headers.set("retry-after", String(DEFAULT_RETRY_AFTER_SECONDS));
    }
    else if (apiErr.status === 429 || apiErr.status === 503) {
        headers.set("retry-after", String(DEFAULT_RETRY_AFTER_SECONDS));
    }
    // Add header to indicate if error is retryable
    if (apiErr instanceof errors_1.ApiError) {
        headers.set("x-error-retryable", String(apiErr.retryable));
    }
    return server_1.NextResponse.json(body, { status: apiErr.status, headers });
}
