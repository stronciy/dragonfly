import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { ApiError, prisma } from "@/shared";
import { getFinanceSnapshot } from "@/services/finance.service";

/** Фінансовий журнал поточної ролі користувача (оплати, застави, виплати). */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer" && user.role !== "performer") {
      throw new ApiError(403, "FORBIDDEN", "Фінанси доступні лише замовнику та виконавцю");
    }
    const { entries, summary } = await getFinanceSnapshot(prisma, user.id, user.role);
    return ok(req, { role: user.role, summary, entries });
  } catch (err) {
    return fail(req, err);
  }
}
