import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import {
  getLatestArbitrationResolution,
  serializeArbitrationResolution,
} from "@/shared";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || (order.customerUserId !== user.id && order.performerUserId !== user.id)) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    const latest = await getLatestArbitrationResolution(orderId);
    return ok(req, { resolution: latest ? serializeArbitrationResolution(latest) : null });
  } catch (err) {
    return fail(req, err);
  }
}

/** Пропозиція рішення більше не створюється: спір вирішує адміністратор. */
export async function POST(req: Request, _ctx?: unknown) {
  return fail(req, new ApiError(403, "FORBIDDEN", "Рішення в арбітражі ухвалює адміністратор. Сторони передають пояснення в чат арбітражу."));
}
