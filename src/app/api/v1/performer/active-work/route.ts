import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const order = await prisma.order.findFirst({
      where: { performerUserId: user.id, status: { in: ["confirmed", "started", "completed", "arbitration"] } },
      orderBy: { updatedAt: "desc" },
    });

    if (!order) return ok(req, { activeWork: null });

    const customer = await prisma.user.findUnique({ where: { id: order.customerUserId }, select: { id: true, name: true, phone: true } });

    return ok(req, {
      activeWork: {
        orderId: order.id,
        status: order.status,
        title: order.locationLabel,
        areaHa: Number(order.areaHa),
        locationLabel: order.locationLabel,
        customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : null,
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
