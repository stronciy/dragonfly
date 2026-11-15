import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { prisma } from "@/shared";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);
    await prisma.adminTelegramLink.deleteMany({ where: { adminId: admin.id } });
    return ok(req, { linked: false }, { message: "Telegram відключено" });
  } catch (err) {
    return fail(req, err);
  }
}
