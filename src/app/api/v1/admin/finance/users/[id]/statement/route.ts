import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { getUserStatement } from "@/services/adminFinance.service";
import { ApiError } from "@/shared";

export const runtime = "nodejs";

/** Детальна фінансова виписка по рахунку користувача. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePanelAdmin(req, "finance.read");
    const { id } = await ctx.params;
    const statement = await getUserStatement(id);
    if (!statement) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");
    return ok(req, statement);
  } catch (err) {
    return fail(req, err);
  }
}
