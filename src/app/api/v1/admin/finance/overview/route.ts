import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { getCompanyEarnings, getPerformerBalances } from "@/services/adminFinance.service";

export const runtime = "nodejs";

/** Огляд фінансів для панелі: заробіток компанії та виконавці з коштами до виведення. */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req);
    const [company, performers] = await Promise.all([getCompanyEarnings(), getPerformerBalances()]);
    return ok(req, { company, performers });
  } catch (err) {
    return fail(req, err);
  }
}
