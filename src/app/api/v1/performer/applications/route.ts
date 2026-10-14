import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";
import { listApplicationsForPerformer } from "@/services/application.service";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");

    const { limit, offset } = parsePagination(new URL(req.url));
    const { items, total } = await listApplicationsForPerformer(user.id, { limit, offset });

    return ok(req, { items, page: makePage(limit, offset, total) });
  } catch (err) {
    return fail(req, err);
  }
}
