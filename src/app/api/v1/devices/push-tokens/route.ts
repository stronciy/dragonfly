import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

const schema = z.object({
  expoPushToken: z.string().min(10),
  platform: z.enum(["ios", "android"]),
  deviceId: z.string().min(1).optional(),
  appVersion: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = schema.parse(await req.json());

    const device = await prisma.device.upsert({
      where: { expoPushToken: body.expoPushToken },
      update: {
        userId: user.id,
        platform: body.platform,
        deviceId: body.deviceId ?? null,
        appVersion: body.appVersion ?? null,
        revokedAt: null,
      },
      create: {
        userId: user.id,
        expoPushToken: body.expoPushToken,
        platform: body.platform,
        deviceId: body.deviceId ?? null,
        appVersion: body.appVersion ?? null,
      },
      select: { id: true, expoPushToken: true, platform: true, createdAt: true },
    });

    return ok(req, { device }, { status: 201, message: "Зареєстровано" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
