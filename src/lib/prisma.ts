import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      const db = u.pathname?.startsWith("/") ? u.pathname.slice(1) : u.pathname;
      const schema = u.searchParams.get("schema") ?? "public";
      console.info(`[prisma] connected host=${u.hostname} port=${u.port || "5432"} db=${db} schema=${schema}`);
    } catch {
      console.warn("[prisma] DATABASE_URL is not a valid URL");
    }
  } else {
    console.warn("[prisma] DATABASE_URL is not set");
  }
}
