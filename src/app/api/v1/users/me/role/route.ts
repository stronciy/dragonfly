import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  role: z.enum(["customer", "performer"]),
});

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    const body = schema.parse(await req.json());

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: user.id },
        data: { role: body.role },
        select: { id: true, role: true },
      });

      if (body.role === "customer") {
        await tx.customerProfile.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id },
        });
      } else {
        await tx.performerProfile.upsert({
          where: { userId: user.id },
          update: {},
          create: {
            userId: user.id,
            coverageMode: "radius",
            coverageRadiusKm: 50,
            vatPayer: false,
            avgRating: 0,
            reviewCount: 0,
          },
        });
      }

      return u;
    });

    return ok(req, { user: updated }, { message: "Role updated" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
