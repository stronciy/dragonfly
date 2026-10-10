import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

type StatusRow = { status: string; _count: { _all: number } };

// Одне джерело правди для особистих лічильників під системним пульсом.
function reduce(rows: StatusRow[]) {
  const m: Record<string, number> = {};
  for (const r of rows) m[r.status] = r._count._all;
  const sum = (...s: string[]) => s.reduce((acc, k) => acc + (m[k] ?? 0), 0);
  return {
    total: rows.reduce((a, r) => a + r._count._all, 0),
    open: sum("published", "draft"),
    awaitingDeposit: sum("accepted", "requires_confirmation"),
    inProgress: sum("confirmed", "started"),
    completed: sum("completed"),
    arbitration: sum("arbitration"),
    cancelled: sum("cancelled"),
  };
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const [asCustomer, asPerformer] = await Promise.all([
      prisma.order.groupBy({
        by: ["status"],
        where: { customerUserId: user.id },
        _count: { _all: true },
      }),
      prisma.order.groupBy({
        by: ["status"],
        where: { performerUserId: user.id },
        _count: { _all: true },
      }),
    ]);
    return ok(req, { asCustomer: reduce(asCustomer), asPerformer: reduce(asPerformer) });
  } catch (err) {
    return fail(req, err);
  }
}
