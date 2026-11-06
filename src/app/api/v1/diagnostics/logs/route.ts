import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

// Журнал дій і відповідей API з застосунку для розробників. Пишеться в серверний
// лог (docker/CapRover logs), по одному рядку на запис, з reportId для пошуку.
const reportSchema = z.object({
  capturedAt: z.string().max(40),
  device: z.record(z.string(), z.any()).optional(),
  user: z.object({ id: z.string().max(64), role: z.string().max(20) }).nullable().optional(),
  entries: z
    .array(
      z.object({
        t: z.string().max(40),
        kind: z.string().max(20),
        msg: z.string().max(300),
        data: z.string().max(2000).optional(),
      })
    )
    .max(600),
});

function log(payload: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ level: "info", ...payload }) + "\n");
}

export async function POST(req: Request) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const body = reportSchema.parse(await req.json());
    const reportId = crypto.randomUUID();
    const device = body.device ?? {};
    const str = (value: unknown, max = 120) =>
      typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

    await prisma.clientDiagnosticReport.create({
      data: {
        reportId,
        userId: user.id,
        userRole: user.role,
        userName: str(user.name),
        userPhone: str(user.phone, 40),
        appVersion: str(device.appVersion, 40),
        buildNumber: str(device.buildNumber, 40),
        platform: str(device.platform, 20),
        osVersion: str(device.osVersion, 40),
        deviceModel: str(device.model, 80),
        isDevice: typeof device.isDevice === "boolean" ? device.isDevice : null,
        capturedAt: Number.isNaN(Date.parse(body.capturedAt)) ? new Date() : new Date(body.capturedAt),
        entryCount: body.entries.length,
        entries: body.entries,
      },
    });

    log({
      msg: "client_diagnostics_report",
      reportId,
      requestId,
      userId: user.id,
      userRole: user.role,
      reporter: body.user ?? null,
      device: body.device ?? null,
      capturedAt: body.capturedAt,
      entryCount: body.entries.length,
    });
    body.entries.forEach((entry, idx) => {
      log({
        msg: "client_diagnostics_entry",
        reportId,
        idx,
        t: entry.t,
        kind: entry.kind,
        text: entry.msg,
        data: entry.data ?? null,
      });
    });

    return ok(req, { reportId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірний формат логів", err.flatten()));
    }
    return fail(req, err);
  }
}
