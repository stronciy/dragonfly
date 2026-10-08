import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { readFormFileAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { customerUserId: true, performerUserId: true, status: true } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const canUpload =
      (user.role === "customer" && order.customerUserId === user.id) ||
      (user.role === "performer" && order.performerUserId === user.id);
    if (!canUpload) throw new ApiError(404, "NOT_FOUND", "Order not found");

    if (order.status !== "arbitration") throw new ApiError(409, "CONFLICT", "Order is not in arbitration");

    const form = await req.formData();
    const { dataUrl, mimeType, size, name } = await readFormFileAsDataUrl(form, "file");

    const media = await prisma.orderMedia.create({
      data: {
        orderId,
        userId: user.id,
        kind: "arbitration",
        name,
        mimeType,
        size,
        url: dataUrl,
      },
      select: { id: true, createdAt: true },
    });

    return ok(req, { media }, { status: 201, message: "Uploaded" });
  } catch (err) {
    return fail(req, err);
  }
}
