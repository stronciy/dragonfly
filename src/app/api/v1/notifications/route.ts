import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";
import { ApiError } from "@/lib/errors";

const querySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  type: z.enum(["system", "order", "deposit", "marketplace", "arbitration", "payout"]).optional(),
  role: z.enum(["customer", "performer"]).optional(),
});

export async function GET(req: Request) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);
    const { unreadOnly, type, role } = querySchema.parse({
      unreadOnly: url.searchParams.get("unreadOnly") ?? undefined,
      type: url.searchParams.get("type") ?? undefined,
      role: url.searchParams.get("role") ?? undefined,
    });

    // Фільтрація по ролях: якщо role вказано, повертаємо тільки повідомлення для цієї ролі
    // Якщо role не вказано, повертаємо повідомлення для ролі користувача або загальні (без ролі)
    const roleFilter = role || user.role;
    
    const where = {
      userId: user.id,
      ...(unreadOnly ? { readAt: null } : {}),
      ...(type ? { type } : {}),
      // Фільтр по ролях: якщо в notification.data є role, він має співпадати з roleFilter
      // Якщо roleFilter не співпадає, повідомлення не повертається
    };

    const [items, totalCount] = await prisma.$transaction([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: { id: true, title: true, message: true, type: true, data: true, createdAt: true, readAt: true },
      }),
      prisma.notification.count({ where }),
    ]);

    const mapped = items
      .filter((n) => {
        // Фільтрація по ролях на клієнті: якщо в data є role, перевіряємо співпадіння
        const data = n.data as unknown;
        const notificationRole =
          data && typeof data === "object" && "role" in data
            ? (data as Record<string, unknown>).role
            : null;
        
        // Якщо notificationRole є і не співпадає з roleFilter, фільтруємо
        if (notificationRole && notificationRole !== roleFilter) {
          return false;
        }
        return true;
      })
      .map((n) => {
        const data = n.data as unknown;
        const orderId =
          data && typeof data === "object" && "orderId" in data && typeof (data as Record<string, unknown>).orderId === "string"
            ? ((data as Record<string, unknown>).orderId as string)
            : null;

        return { ...n, orderId };
      });

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] GET /api/v1/notifications requestId=${requestId} userId=${user.id} total=${totalCount} returned=${mapped.length}`);
    }

    return ok(req, { items: mapped, page: makePage(limit, offset, totalCount) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
