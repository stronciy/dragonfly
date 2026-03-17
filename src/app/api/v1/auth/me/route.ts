import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    return ok(req, { user });
  } catch (err) {
    return fail(req, err);
  }
}
