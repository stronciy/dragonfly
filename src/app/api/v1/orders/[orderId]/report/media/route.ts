import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { readFormFileAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { performerUserId: true, status: true } });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (!["confirmed", "started", "arbitration"].includes(order.status)) throw new ApiError(403, "FORBIDDEN", "Завантаження заборонено");

    const form = await req.formData();
    const { dataUrl, mimeType, size, name } = await readFormFileAsDataUrl(form, "file");
    const caption = form.get("caption");

    const media = await prisma.orderMedia.create({
      data: {
        orderId,
        userId: user.id,
        kind: "report",
        name,
        mimeType,
        size,
        url: dataUrl,
        caption: typeof caption === "string" ? caption : null,
      },
      select: { id: true, createdAt: true },
    });

    return ok(req, { media }, { status: 201, message: "Завантажено" });
  } catch (err) {
    return fail(req, err);
  }
}
