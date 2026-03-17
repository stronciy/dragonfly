import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { readFormFileAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { customerUserId: true, performerUserId: true } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const canUpload =
      (user.role === "customer" && order.customerUserId === user.id) ||
      (user.role === "performer" && order.performerUserId === user.id);
    if (!canUpload) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const form = await req.formData();
    const { dataUrl, mimeType, size, name } = await readFormFileAsDataUrl(form, "file");

    const arbitrationCase = await prisma.arbitrationCase.findUnique({ where: { orderId }, select: { id: true } });
    if (!arbitrationCase) throw new ApiError(409, "CONFLICT", "Arbitration case not opened");

    const media = await prisma.arbitrationMedia.create({
      data: { caseId: arbitrationCase.id, url: dataUrl, metadata: { mimeType, size, name } },
      select: { id: true, url: true, createdAt: true },
    });

    return ok(req, { media }, { status: 201, message: "Uploaded" });
  } catch (err) {
    return fail(req, err);
  }
}
