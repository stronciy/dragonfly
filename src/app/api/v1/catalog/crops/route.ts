import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const crops = await prisma.crop.findMany({ orderBy: [{ sort: "asc" }, { name: "asc" }] });
    return ok(req, { crops: crops.map((c) => ({ id: c.id, name: c.name, iconKey: c.iconKey })) });
  } catch (err) {
    return fail(req, err);
  }
}
