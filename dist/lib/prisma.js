"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const adapter_pg_1 = require("@prisma/adapter-pg");
const client_1 = require("../generated/prisma/client");
const globalForPrisma = globalThis;
exports.prisma = (_a = globalForPrisma.prisma) !== null && _a !== void 0 ? _a : new client_1.PrismaClient({ adapter: new adapter_pg_1.PrismaPg({ connectionString: process.env.DATABASE_URL }) });
if (process.env.NODE_ENV !== "production")
    globalForPrisma.prisma = exports.prisma;
