import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { InputJsonValue } from "@/generated/prisma/internal/prismaNamespace";
import { liqpayDecodeData, liqpayVerifySignature } from "@/services/liqpay.service";

function parseBody(contentType: string | null, raw: string) {
  if (contentType && contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    return {
      data: params.get("data") ?? "",
      signature: params.get("signature") ?? "",
    };
  }

  try {
    const json = JSON.parse(raw) as { data?: unknown; signature?: unknown };
    return {
      data: typeof json.data === "string" ? json.data : "",
      signature: typeof json.signature === "string" ? json.signature : "",
    };
  } catch {
    return { data: "", signature: "" };
  }
}

function mapLiqPayStatus(status: unknown) {
  const s = String(status || "").toLowerCase();
  if (s === "success" || s === "sandbox") return "succeeded";
  if (
    s === "processing" ||
    s === "wait_accept" ||
    s === "wait_secure" ||
    s === "wait_sender" ||
    s === "wait_card" ||
    s === "wait_lc"
  ) {
    return "processing";
  }
  if (s === "reversed" || s === "canceled") return "canceled";
  if (s === "failure" || s === "error" || s === "expired") return "failed";
  return "requires_action";
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const { data, signature } = parseBody(req.headers.get("content-type"), raw);

    if (!data || !signature) throw new ApiError(400, "VALIDATION_ERROR", "Missing data/signature");
    const okSig = liqpayVerifySignature(data, signature);
    if (!okSig) throw new ApiError(401, "UNAUTHORIZED", "Invalid provider signature");

    const decoded = liqpayDecodeData(data);
    const providerIntentId = String(decoded.order_id || "");
    if (!providerIntentId) throw new ApiError(400, "VALIDATION_ERROR", "Missing order_id");

    const payment = await prisma.payment.findFirst({
      where: { provider: "liqpay", providerIntentId },
      select: { id: true, status: true, amount: true, currency: true, orderId: true, userId: true, providerIntentId: true },
    });

    if (!payment) {
      return ok(req, { received: true, ignored: true }, { message: "Ignored" });
    }

    const nextStatus = mapLiqPayStatus(decoded.status);

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: nextStatus,
        paidAt: nextStatus === "succeeded" ? new Date() : null,
        raw: { webhook: { data, signature }, liqpay: decoded } as unknown as InputJsonValue,
      },
      select: { id: true, status: true, amount: true, currency: true, paidAt: true, orderId: true, userId: true },
    });

    if (updated.status === "succeeded") {
      const [order, dbUser] = await prisma.$transaction([
        prisma.order.findUnique({ where: { id: updated.orderId }, select: { id: true, status: true } }),
        prisma.user.findUnique({ where: { id: updated.userId }, select: { role: true } }),
      ]);

      if (order && dbUser) {
        const role: "performer" | "customer" = dbUser.role === "performer" ? "performer" : "customer";
        const providerRef = String(
          (decoded as Record<string, unknown>).payment_id ||
            (decoded as Record<string, unknown>).transaction_id ||
            (decoded as Record<string, unknown>).liqpay_order_id ||
            payment.providerIntentId
        );

        await prisma.escrowLock.upsert({
          where: { uniq_order_role_lock: { orderId: order.id, role } },
          update: { status: "locked" },
          create: {
            orderId: order.id,
            userId: updated.userId,
            role,
            status: "locked",
            amount: updated.amount,
            currency: updated.currency,
            provider: "liqpay",
            providerRef,
          },
        });

        if (order.status === "accepted") {
          const [customerLock, performerLock] = await prisma.$transaction([
            prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "customer", status: "locked" } }),
            prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "performer", status: "locked" } }),
          ]);
          if (customerLock && performerLock) {
            await prisma.$transaction([
              prisma.order.updateMany({ where: { id: order.id, status: "accepted" }, data: { status: "confirmed" } }),
              prisma.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: "accepted", toStatus: "confirmed", note: null } }),
              prisma.orderMatch.deleteMany({ where: { orderId: order.id } }),
            ]);
          }
        }
      }
    }

    return ok(req, { received: true, payment: { id: updated.id, status: updated.status } }, { message: "OK" });
  } catch (err) {
    return fail(req, err);
  }
}

