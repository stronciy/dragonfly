import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const categories = await prisma.serviceCategory.findMany({
      orderBy: [{ sort: "asc" }, { name: "asc" }],
      include: {
        subcategories: {
          orderBy: [{ sort: "asc" }, { name: "asc" }],
          include: {
            types: { orderBy: [{ sort: "asc" }, { name: "asc" }] },
          },
        },
      },
    });

    return ok(req, {
      categories: categories.map((c) => ({
        serviceCategoryId: c.id,
        serviceCategoryName: c.name,
        iconKey: c.iconKey,
        subcategories: c.subcategories.map((s) => ({
          serviceSubCategoryId: s.id,
          serviceSubCategoryName: s.name,
          iconKey: s.iconKey,
          types: s.types.map((t) => ({
            serviceTypeId: t.id,
            serviceTypeName: t.name,
          })),
        })),
      })),
    });
  } catch (err) {
    return fail(req, err);
  }
}
