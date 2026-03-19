"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = requireRole;
exports.requireAnyRole = requireAnyRole;
const errors_1 = require("../errors");
function requireRole(user, role) {
    if (user.role !== role)
        throw new errors_1.ApiError(403, "FORBIDDEN", `${role} role required`);
}
function requireAnyRole(user, roles) {
    if (!roles.includes(user.role)) {
        throw new errors_1.ApiError(403, "FORBIDDEN", "Insufficient permissions");
    }
}
