"use strict";
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const adapter_pg_1 = require("@prisma/adapter-pg");
const client_1 = require("../../generated/prisma/client");
const globalForPrisma = globalThis;
exports.prisma = (_a = globalForPrisma.prisma) !== null && _a !== void 0 ? _a : new client_1.PrismaClient({ adapter: new adapter_pg_1.PrismaPg({ connectionString: process.env.DATABASE_URL }) });
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = exports.prisma;
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
        try {
            const u = new URL(dbUrl);
            const db = ((_b = u.pathname) === null || _b === void 0 ? void 0 : _b.startsWith("/")) ? u.pathname.slice(1) : u.pathname;
            const schema = (_c = u.searchParams.get("schema")) !== null && _c !== void 0 ? _c : "public";
            console.info(`[prisma] connected host=${u.hostname} port=${u.port || "5432"} db=${db} schema=${schema}`);
        }
        catch (_d) {
            console.warn("[prisma] DATABASE_URL is not a valid URL");
        }
    }
    else {
        console.warn("[prisma] DATABASE_URL is not set");
    }
}
