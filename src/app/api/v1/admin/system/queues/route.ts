import { ApiError, prisma } from "@/shared";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { clearQueues, getQueuesSnapshot } from "@/shared";

export const runtime = "nodejs";

/** OPS: read-only queue counters for the admin system page. */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req);
    const queues = await getQueuesSnapshot();
    return ok(req, { queues });
  } catch (err) {
    return fail(req, err);
  }
}

/**
 * OPS: drop waiting/delayed/failed/completed jobs without touching business
 * data. Useful when a test run left a stuck job and the operator does not want
 * to wipe the whole database.
 */
export async function POST(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);

    const result = await clearQueues();
    if (!result.ok) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Не вдалося очистити всі черги",
        { errors: result.errors },
        true
      );
    }

    await prisma.$transaction((tx) =>
      writeAuditLog(tx, req, {
        admin,
        action: "system.queues_clear",
        entityType: "queues",
        entityId: "all",
        after: {
          cleared: result.cleared,
        },
      })
    );

    return ok(req, result, { message: "Черги очищено" });
  } catch (err) {
    return fail(req, err);
  }
}
