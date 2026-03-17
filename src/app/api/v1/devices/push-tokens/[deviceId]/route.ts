import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";

export async function DELETE(req: Request, ctx: { params: Promise<{ deviceId: string }> }) {
  try {
    const user = await requireUser(req);
    const { deviceId } = await ctx.params;

    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true, userId: true } });
    if (!device || device.userId !== user.id) throw new ApiError(404, "NOT_FOUND", "Device not found");

    await prisma.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
    return ok(req, {}, { status: 204, message: "Deleted" });
  } catch (err) {
    return fail(req, err);
  }
}
