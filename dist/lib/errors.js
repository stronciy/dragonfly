"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = void 0;
exports.asApiError = asApiError;
class ApiError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
exports.ApiError = ApiError;
function asApiError(err) {
    if (err instanceof ApiError)
        return err;
    if (err instanceof Error)
        return new ApiError(500, "INTERNAL_ERROR", err.message);
    return new ApiError(500, "INTERNAL_ERROR", "Unknown error");
}
