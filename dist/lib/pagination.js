"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paginationSchema = void 0;
exports.parsePagination = parsePagination;
exports.makePage = makePage;
const zod_1 = require("zod");
exports.paginationSchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    offset: zod_1.z.coerce.number().int().min(0).default(0),
});
function parsePagination(url) {
    var _a, _b;
    const limit = (_a = url.searchParams.get("limit")) !== null && _a !== void 0 ? _a : undefined;
    const offset = (_b = url.searchParams.get("offset")) !== null && _b !== void 0 ? _b : undefined;
    return exports.paginationSchema.parse({ limit, offset });
}
function makePage(limit, offset, totalCount) {
    return { limit, offset, hasMore: offset + limit < totalCount };
}
