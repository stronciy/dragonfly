import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { prisma } from "@/shared";

export const runtime = "nodejs";

/** Черга заявок на виведення для панелі адміністратора. */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "requested";
    const payouts = await prisma.payout.findMany({
      where: status === "all" ? {} : { status },
      orderBy: { requestedAt: "asc" },
      take: 200,
      select: {
        id: true,
        amount: true,
        currency: true,
        iban: true,
        accountName: true,
        status: true,
        requestedAt: true,
        processedAt: true,
        rejectReason: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    return ok(req, {
      payouts: payouts.map((p) => ({ ...p, amount: Number(p.amount) })),
    });
  } catch (err) {
    return fail(req, err);
  }
}
