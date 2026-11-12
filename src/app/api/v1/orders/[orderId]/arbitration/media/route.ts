import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { readFormFileAsDataUrl } from "@/lib/uploads";
import { readMultipartForm } from "@/lib/multipart";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { customerUserId: true, performerUserId: true, status: true } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    const canUpload =
      order.customerUserId === user.id || order.performerUserId === user.id;
    if (!canUpload) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    if (order.status !== "arbitration") throw new ApiError(409, "CONFLICT", "Замовлення не в арбітражі");

    const form = await readMultipartForm(req);
    const { dataUrl, mimeType, size, name } = await readFormFileAsDataUrl(form, "file");

    const openCase = await prisma.arbitrationCase.findFirst({
      where: { orderId, status: { in: ["open", "admin_assigned"] } },
      select: { id: true },
    });
    if (!openCase) throw new ApiError(409, "CONFLICT", "Відкритий арбітраж не знайдено");

    const message =
      (await prisma.arbitrationMessage.findFirst({
        where: { arbitrationCaseId: openCase.id, userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })) ??
      (await prisma.arbitrationMessage.create({
        data: { arbitrationCaseId: openCase.id, userId: user.id, text: "Додаткові докази" },
        select: { id: true },
      }));

    const media = await prisma.orderMedia.create({
      data: {
        orderId,
        userId: user.id,
        kind: "arbitration",
        name,
        mimeType,
        size,
        url: dataUrl,
        arbitrationMessageId: message.id,
      },
      select: { id: true, createdAt: true },
    });

    return ok(req, { media }, { status: 201, message: "Завантажено" });
  } catch (err) {
    return fail(req, err);
  }
}
