"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireUser = requireUser;
const prisma_1 = require("../prisma");
const errors_1 = require("../errors");
const tokens_1 = require("./tokens");
async function requireUser(req) {
    const auth = req.headers.get("authorization");
    if (!(auth === null || auth === void 0 ? void 0 : auth.startsWith("Bearer ")))
        throw new errors_1.ApiError(401, "UNAUTHORIZED", "Missing access token");
    const token = auth.slice("Bearer ".length).trim();
    if (!token)
        throw new errors_1.ApiError(401, "UNAUTHORIZED", "Missing access token");
    let payload;
    try {
        payload = await (0, tokens_1.verifyAccessToken)(token);
    }
    catch (_a) {
        throw new errors_1.ApiError(401, "UNAUTHORIZED", "Invalid access token");
    }
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, name: true, email: true, role: true, phone: true, createdAt: true },
    });
    if (!user)
        throw new errors_1.ApiError(401, "UNAUTHORIZED", "User not found");
    return user;
}
