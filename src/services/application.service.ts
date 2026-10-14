import { Prisma } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { prisma } from "../lib/prisma";
import { maskOrderLocationForMarketplace } from "../lib/marketplaceVisibility";
import { claimOrderForPerformer } from "./deposit.service";

type Db = Prisma.TransactionClient;

export interface ApplicationRecord {
  id: string;
  orderId: string;
  performerUserId: string;
  type: string;
  message: string | null;
  proposedPriceUah: Prisma.Decimal | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
}

export function serializeApplication(app: ApplicationRecord) {
  return {
    id: app.id,
    orderId: app.orderId,
    performerUserId: app.performerUserId,
    type: app.type,
    message: app.message,
    proposedPriceUah: app.proposedPriceUah == null ? null : Number(app.proposedPriceUah),
    status: app.status,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    decidedAt: app.decidedAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createApplication(
  db: Db,
  args: {
    orderId: string;
    performerUserId: string;
    type: string;
    message?: string | null;
    proposedPriceUah?: number | null;
  }
) {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, status: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  if (order.status !== "published") {
    throw new ApiError(409, "CONFLICT", "Заявку можна подати лише на опубліковане замовлення");
  }

  const data = {
    type: args.type,
    message: args.message ?? null,
    proposedPriceUah: args.proposedPriceUah ?? null,
  };

  const existing = await db.orderApplication.findUnique({
    where: {
      uniq_order_performer_application: {
        orderId: args.orderId,
        performerUserId: args.performerUserId,
      },
    },
    select: { id: true, status: true },
  });

  if (existing) {
    // Upsert: a withdrawn application can be re-submitted (reset to pending);
    // any other status is an active duplicate.
    if (existing.status !== "withdrawn") {
      throw new ApiError(409, "CONFLICT", "Заявку на це замовлення вже подано");
    }
    return db.orderApplication.update({
      where: { id: existing.id },
      data: { ...data, status: "pending", decidedAt: null },
    });
  }

  try {
    return await db.orderApplication.create({
      data: {
        orderId: args.orderId,
        performerUserId: args.performerUserId,
        ...data,
        status: "pending",
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, "CONFLICT", "Заявку на це замовлення вже подано");
    }
    throw err;
  }
}

export async function withdrawApplication(args: {
  orderId: string;
  performerUserId: string;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const existing = await db.orderApplication.findUnique({
    where: {
      uniq_order_performer_application: {
        orderId: args.orderId,
        performerUserId: args.performerUserId,
      },
    },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Заявку не знайдено");
  if (existing.status !== "pending") {
    throw new ApiError(409, "CONFLICT", "Відкликати можна лише заявку в очікуванні");
  }
  return db.orderApplication.update({
    where: { id: existing.id },
    data: { status: "withdrawn", decidedAt: new Date() },
  });
}

async function runAccept(tx: Db, args: { orderId: string; customerUserId: string; applicationId: string }) {
  const order = await tx.order.findUnique({ where: { id: args.orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  if (order.customerUserId !== args.customerUserId) {
    throw new ApiError(403, "FORBIDDEN", "Лише замовник може прийняти заявку");
  }
  if (order.status !== "published") {
    throw new ApiError(409, "CONFLICT", "Замовлення більше недоступне для прийняття заявок");
  }

  const application = await tx.orderApplication.findUnique({ where: { id: args.applicationId } });
  if (!application || application.orderId !== args.orderId) {
    throw new ApiError(404, "NOT_FOUND", "Заявку не знайдено");
  }
  if (application.status !== "pending") {
    throw new ApiError(409, "CONFLICT", "Заявку вже оброблено");
  }

  const now = new Date();
  const { order: claimed } = await claimOrderForPerformer(tx, {
    orderId: args.orderId,
    performerUserId: application.performerUserId,
  });
  const accepted = await tx.orderApplication.update({
    where: { id: application.id },
    data: { status: "accepted", decidedAt: now },
  });
  await tx.orderApplication.updateMany({
    where: { orderId: args.orderId, status: "pending", id: { not: application.id } },
    data: { status: "rejected", decidedAt: now },
  });
  return { order: claimed, application: accepted };
}

export async function acceptApplication(args: {
  orderId: string;
  customerUserId: string;
  applicationId: string;
  db?: Db;
}) {
  if (args.db) return runAccept(args.db, args);
  return prisma.$transaction((tx) => runAccept(tx, args));
}

export async function rejectApplication(args: {
  orderId: string;
  customerUserId: string;
  applicationId: string;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, customerUserId: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  if (order.customerUserId !== args.customerUserId) {
    throw new ApiError(403, "FORBIDDEN", "Лише замовник може відхилити заявку");
  }

  const application = await db.orderApplication.findUnique({ where: { id: args.applicationId } });
  if (!application || application.orderId !== args.orderId) {
    throw new ApiError(404, "NOT_FOUND", "Заявку не знайдено");
  }
  if (application.status !== "pending") {
    throw new ApiError(409, "CONFLICT", "Заявку вже оброблено");
  }
  return db.orderApplication.update({
    where: { id: application.id },
    data: { status: "rejected", decidedAt: new Date() },
  });
}

export async function listApplicationsForOrder(orderId: string, db: Db = prisma) {
  const rows = await db.orderApplication.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    include: {
      performer: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          performerProfile: {
            select: { avgRating: true, reviewCount: true, companyName: true },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    ...serializeApplication(row),
    performer: row.performer
      ? {
          id: row.performer.id,
          name: row.performer.name,
          avatarUrl: row.performer.avatarUrl,
          companyName: row.performer.performerProfile?.companyName ?? null,
          rating: row.performer.performerProfile?.avgRating ?? null,
          reviewCount: row.performer.performerProfile?.reviewCount ?? null,
        }
      : null,
  }));
}

export async function listApplicationsForPerformer(
  performerUserId: string,
  args: { limit: number; offset: number },
  db: Db = prisma
) {
  const [rows, total] = await db.$transaction([
    db.orderApplication.findMany({
      where: { performerUserId },
      orderBy: { createdAt: "desc" },
      take: args.limit,
      skip: args.offset,
      include: {
        order: {
          select: {
            id: true,
            status: true,
            orderNumber: true,
            serviceCategoryId: true,
            serviceSubCategoryId: true,
            serviceTypeId: true,
            areaHa: true,
            dateFrom: true,
            dateTo: true,
            budget: true,
            currency: true,
            locationLabel: true,
            regionName: true,
            settlementName: true,
            lat: true,
            lng: true,
            performerUserId: true,
            createdAt: true,
          },
        },
      },
    }),
    db.orderApplication.count({ where: { performerUserId } }),
  ]);

  const items = rows.map((row) => {
    const o = row.order;
    const locationMask = maskOrderLocationForMarketplace(
      {
        status: o.status,
        locationLabel: o.locationLabel,
        regionName: o.regionName,
        settlementName: o.settlementName,
        lat: Number(o.lat),
        lng: Number(o.lng),
      },
      { assigned: o.performerUserId === performerUserId }
    );
    return {
      ...serializeApplication(row),
      order: {
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        serviceCategoryId: o.serviceCategoryId,
        serviceSubCategoryId: o.serviceSubCategoryId,
        serviceTypeId: o.serviceTypeId,
        areaHa: Number(o.areaHa),
        dateFrom: o.dateFrom,
        dateTo: o.dateTo,
        budget: Number(o.budget),
        currency: o.currency,
        createdAt: o.createdAt,
        ...locationMask,
      },
    };
  });

  return { items, total };
}
