import { z } from "zod";

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function parsePagination(url: URL) {
  const limit = url.searchParams.get("limit") ?? undefined;
  const offset = url.searchParams.get("offset") ?? undefined;
  return paginationSchema.parse({ limit, offset });
}

export function makePage(limit: number, offset: number, totalCount: number) {
  return { limit, offset, hasMore: offset + limit < totalCount };
}
