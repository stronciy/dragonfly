import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  amount: z.number().positive(),
  method: z.enum(["card", "iban"]),
  destination: z.string().min(4).max(128),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const body = schema.parse(await req.json());

    const payout = await prisma.payout.create({
      data: {
        performerUserId: user.id,
        amount: body.amount,
        currency: "UAH",
        status: "pending",
        providerRef: `${body.method}:${body.destination}`,
      },
      select: { id: true, amount: true, currency: true, status: true },
    });

    return ok(req, { withdrawIntent: payout }, { message: "Created" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
