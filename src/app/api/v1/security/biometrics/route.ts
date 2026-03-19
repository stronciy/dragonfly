import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  enabled: z.boolean(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { biometricsEnabled: true } });
    return ok(req, { biometrics: { enabled: Boolean(dbUser?.biometricsEnabled) } });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    const body = patchSchema.parse(await req.json());

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { biometricsEnabled: body.enabled },
      select: { biometricsEnabled: true },
    });

    return ok(req, { biometrics: { enabled: updated.biometricsEnabled } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

