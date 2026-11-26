import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { searchFinanceUsers } from "@/services/adminFinance.service";

export const runtime = "nodejs";

/** Пошук користувача для фінансової виписки. */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req, "finance.read");
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const users = await searchFinanceUsers(q);
    return ok(req, { users });
  } catch (err) {
    return fail(req, err);
  }
}
