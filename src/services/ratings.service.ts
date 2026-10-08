import { prisma } from "../lib/prisma";

// Оцінка видима лише якщо є зустрічна оцінка іншої сторони того ж замовлення.
async function visibleRatingsFor(target: { performerUserId?: string; customerUserId?: string }) {
  const mine = await prisma.review.findMany({
    where: { ...target },
    select: { orderId: true, rating: true },
  });
  if (mine.length === 0) return [];
  const orderIds = Array.from(new Set(mine.map((r) => r.orderId)));
  const authors = await prisma.review.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, authorUserId: true },
    distinct: ["orderId", "authorUserId"],
  });
  const counts = new Map<string, number>();
  for (const a of authors) counts.set(a.orderId, (counts.get(a.orderId) ?? 0) + 1);
  return mine.filter((r) => (counts.get(r.orderId) ?? 0) >= 2);
}

function average(ratings: { rating: number }[]) {
  if (ratings.length === 0) return { avg: 0, count: 0 };
  const avg = Number((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(2));
  return { avg, count: ratings.length };
}

export async function recomputePerformerRating(performerUserId: string) {
  const visible = await visibleRatingsFor({ performerUserId });
  const { avg, count } = average(visible);
  await prisma.performerProfile.update({
    where: { userId: performerUserId },
    data: { avgRating: avg, reviewCount: count },
  });
  return { avg, count };
}

export async function getCustomerRating(customerUserId: string) {
  const visible = await visibleRatingsFor({ customerUserId });
  return average(visible);
}
