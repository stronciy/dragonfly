import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { readFormFileAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { performerUserId: true, status: true } });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (!["confirmed", "started", "arbitration"].includes(order.status)) throw new ApiError(403, "FORBIDDEN", "Upload not allowed");

    const form = await req.formData();
    const { dataUrl, mimeType, size, name } = await readFormFileAsDataUrl(form, "file");
    const caption = form.get("caption");

    const media = await prisma.notification.create({
      data: {
        userId: user.id,
        type: "report",
        title: "Media uploaded",
        message: `File ${name} uploaded for order ${orderId}`,
        data: { url: dataUrl, mimeType, size, name, caption: typeof caption === "string" ? caption : null, orderId },
      },
      select: { id: true, createdAt: true },
    });

    return ok(req, { media }, { status: 201, message: "Uploaded" });
  } catch (err) {
    return fail(req, err);
  }
}
