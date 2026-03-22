import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/v1/customers/:customerId/stats
 * 
 * Статистика замовлень заказчикa:
 * - completedSum: сума виконаних замовлень (status = completed)
 * - inProgressSum: сума замовлень в процесі (confirmed, started, arbitration)
 * - activeCount: кількість активних замовлень
 * - completedCount: кількість виконаних замовлень
 * 
 * Виключає:
 * - cancelled
 * - expired (requires_confirmation/accepted з depositDeadline < now)
 */
export async function GET(req: Request, ctx: { params: Promise<{ customerId: string }> }) {
  try {
    const user = await requireUser(req);
    const { customerId } = await ctx.params;
    
    // Перевірка що користувач має доступ до статистики
    if (user.role !== "customer" || user.id !== customerId) {
      throw new ApiError(403, "FORBIDDEN", "Access denied");
    }
    
    const now = new Date();
    const expiredStatuses = ["requires_confirmation", "accepted"];
    
    // Отримуємо всі замовлення заказчикa окрім cancelled
    const orders = await prisma.order.findMany({
      where: {
        customerUserId: customerId,
        status: { not: "cancelled" },
      },
      select: {
        status: true,
        budget: true,
        depositDeadline: true,
      },
    });
    
    // Фільтруємо просрочені
    const activeOrders = orders.filter(order => {
      // Якщо статус requires_confirmation або accepted і depositDeadline < now → просрочено
      if (expiredStatuses.includes(order.status)) {
        if (order.depositDeadline && new Date(order.depositDeadline) < now) {
          return false; // Виключаємо просрочені
        }
      }
      return true;
    });
    
    // Рахуємо суми
    let completedSum = 0;
    let inProgressSum = 0;
    let activeCount = 0;
    let completedCount = 0;
    
    const inProgressStatuses = ["confirmed", "started", "arbitration"];
    
    for (const order of activeOrders) {
      const budget = Number(order.budget);
      
      if (order.status === "completed") {
        completedSum += budget;
        completedCount += 1;
      } else if (inProgressStatuses.includes(order.status)) {
        inProgressSum += budget;
        activeCount += 1;
      } else if (["draft", "published", "requires_confirmation", "accepted"].includes(order.status)) {
        // Активні замовлення які ще не в роботі
        activeCount += 1;
      }
    }
    
    return ok(req, {
      stats: {
        completedSum,
        inProgressSum,
        activeCount,
        completedCount,
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
