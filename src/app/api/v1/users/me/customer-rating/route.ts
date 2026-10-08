import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { getCustomerRating } from "@/shared";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const rating = await getCustomerRating(user.id);
    return ok(req, { rating });
  } catch (err) {
    return fail(req, err);
  }
}
