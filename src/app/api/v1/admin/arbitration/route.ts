import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { prisma } from "@/shared";

export const runtime = "nodejs";

const OPEN_STATUSES = ["open", "admin_assigned"];

/** Список арбітражних кейсів для адмін-панелі. ?status=open (за замовч.) | resolved | all */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req);
    const status = new URL(req.url).searchParams.get("status") ?? "open";
    const where =
      status === "all"
        ? {}
        : status === "resolved"
          ? { status: "resolved" }
          : { status: { in: OPEN_STATUSES } };

    const cases = await prisma.arbitrationCase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            budget: true,
            status: true,
            customerUserId: true,
            performerUserId: true,
          },
        },
        assigneeAdmin: { select: { id: true, email: true } },
        ruling: { select: { decision: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
    });

    return ok(req, { items: cases });
  } catch (err) {
    return fail(req, err);
  }
}
