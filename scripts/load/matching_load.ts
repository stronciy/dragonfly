/**
 * Навантажувальний тест підбору заказів: 20 виконавців, 50 заказчиків.
 *
 * Заказы створюються через справжній маршрут POST /api/v1/orders, підбір робить
 * справжній воркер (черга match-new-order). Результат порівнюється з незалежним
 * розрахунком за правилами: послуга (тип/підкатегорія/категорія) і радіус покриття
 * (країна або Haversine до 150 км). Граничні випадки 149 і 151 км перевіряються окремо.
 *
 * Запуск (тільки локальна база з Docker, ніколи продакшен):
 *   DATABASE_URL=... REDIS_URL=... JWT_ACCESS_SECRET=... npx tsx scripts/load/matching_load.ts
 */
import { Queue } from "bullmq";
import { prisma } from "../../src/shared";
import { servicesTree, getSubcategoryById, getTypeById } from "../../services-tree";
import { signAccessToken } from "../../src/lib/auth/tokens";
import { isWithinUkraine } from "../../src/lib/validators";
import { POST as createOrderPost } from "../../src/app/api/v1/orders/route";
import { GET as marketplaceGet } from "../../src/app/api/v1/marketplace/orders/route";

const PERFORMERS_COUNT = 20;
const CUSTOMERS_COUNT = 50;
const ORDERS_PER_CUSTOMER = 2;
const QUEUE_TIMEOUT_MS = 180_000;

const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl.includes("localhost") && !dbUrl.includes("127.0.0.1")) {
  throw new Error("Тест дозволено лише на локальній базі (localhost)");
}

/** Детермінований генератор, щоб прогін можна було повторити. */
let seed = 20261108;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(rnd() * items.length)];
}

const KM_PER_DEG_LAT = 111.195;
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Міста України для баз виконавців (координати центрів). */
const CITIES: Array<{ name: string; lat: number; lng: number }> = [
  { name: "Київ", lat: 50.4501, lng: 30.5234 },
  { name: "Львів", lat: 49.8397, lng: 24.0297 },
  { name: "Харків", lat: 49.9935, lng: 36.2304 },
  { name: "Одеса", lat: 46.4825, lng: 30.7233 },
  { name: "Дніпро", lat: 48.4647, lng: 35.0462 },
  { name: "Запоріжжя", lat: 47.8388, lng: 35.1396 },
  { name: "Полтава", lat: 49.5883, lng: 34.5514 },
  { name: "Вінниця", lat: 49.2331, lng: 28.4682 },
  { name: "Житомир", lat: 50.2547, lng: 28.6587 },
  { name: "Чернігів", lat: 51.4982, lng: 31.2893 },
  { name: "Суми", lat: 50.9077, lng: 34.7981 },
  { name: "Черкаси", lat: 49.4444, lng: 32.0598 },
  { name: "Херсон", lat: 46.6354, lng: 32.6169 },
  { name: "Миколаїв", lat: 46.9750, lng: 31.9946 },
  { name: "Рівне", lat: 50.6199, lng: 26.2516 },
  { name: "Луцьк", lat: 50.7472, lng: 25.3254 },
  { name: "Тернопіль", lat: 49.5535, lng: 25.5948 },
  { name: "Ужгород", lat: 48.6208, lng: 22.2879 },
  { name: "Івано-Франківськ", lat: 48.9226, lng: 24.7111 },
  { name: "Кропивницький", lat: 48.5079, lng: 32.2623 },
];

type ServiceLevel = { categoryId: string; subcategoryId: string; typeId: string | null };

/** Усі вузли каталогу, з яких можна обрати послугу заказу або виконавця. */
const leaves: ServiceLevel[] = [];
for (const cat of servicesTree.categories) {
  for (const sub of cat.children) {
    const types = sub.children ?? [];
    if (types.length === 0) leaves.push({ categoryId: cat.id, subcategoryId: sub.id, typeId: null });
    for (const type of types) leaves.push({ categoryId: cat.id, subcategoryId: sub.id, typeId: type.id });
  }
}

async function seedCatalog() {
  for (const [ci, cat] of servicesTree.categories.entries()) {
    await prisma.serviceCategory.upsert({
      where: { id: cat.id },
      create: { id: cat.id, name: cat.name, nameUa: cat.name, iconKey: cat.icon ?? null, sort: ci },
      update: { name: cat.name, nameUa: cat.name, sort: ci },
    });
    for (const [si, sub] of cat.children.entries()) {
      await prisma.serviceSubcategory.upsert({
        where: { id: sub.id },
        create: { id: sub.id, categoryId: cat.id, name: sub.name, nameUa: sub.name, iconKey: sub.icon ?? null, sort: si },
        update: { categoryId: cat.id, name: sub.name, nameUa: sub.name, sort: si },
      });
      for (const [ti, type] of (sub.children ?? []).entries()) {
        await prisma.serviceType.upsert({
          where: { subcategoryId_id: { subcategoryId: sub.id, id: type.id } },
          create: { subcategoryId: sub.id, id: type.id, name: type.name, nameUa: type.name, sort: ti },
          update: { name: type.name, nameUa: type.name, sort: ti },
        });
      }
    }
  }
}

type Performer = {
  id: string;
  email: string;
  lat: number;
  lng: number;
  mode: "country" | "radius";
  radiusKm: number | null;
  services: ServiceLevel[];
};

type Customer = { id: string; email: string };

async function createUsers(role: "customer" | "performer", count: number, prefix: string) {
  const ids: Array<{ id: string; email: string }> = [];
  for (let i = 1; i <= count; i++) {
    const email = `load-${prefix}${i}@test.local`;
    const user = await prisma.user.create({
      data: { role, name: `Load ${prefix}${i}`, email, passwordHash: "x", updatedAt: new Date() },
      select: { id: true, email: true },
    });
    ids.push(user);
  }
  return ids;
}

async function seedPerformers(): Promise<Performer[]> {
  const users = await createUsers("performer", PERFORMERS_COUNT, "p");
  const performers: Performer[] = [];
  for (const [i, user] of users.entries()) {
    const city = CITIES[i % CITIES.length];
    // Третина — вся Україна, решта — радіус 50/100/150 км від міста.
    const mode: "country" | "radius" = i % 3 === 0 ? "country" : "radius";
    const radiusKm = mode === "country" ? null : pick([50, 100, 150]);
    const services: ServiceLevel[] = [];
    const count = 1 + Math.floor(rnd() * 3);
    for (let s = 0; s < count; s++) services.push(pick(leaves.length ? leaves : []));
    // Частина виконавців має послугу рівня категорії — щоб перевірити правило на весь розділ.
    if (i % 4 === 0) {
      const cat = pick(servicesTree.categories);
      services.push({ categoryId: cat.id, subcategoryId: "", typeId: null });
    }
    await prisma.performerProfile.create({
      data: {
        userId: user.id,
        baseLatitude: city.lat,
        baseLongitude: city.lng,
        baseLocationLabel: city.name,
        coverageMode: mode,
        coverageRadiusKm: radiusKm,
        updatedAt: new Date(),
      },
    });
    const serviceIds = new Map<string, true>();
    for (const svc of services) {
      const serviceId = svc.typeId ?? (svc.subcategoryId || svc.categoryId);
      if (serviceIds.has(serviceId)) continue;
      serviceIds.set(serviceId, true);
      await prisma.performerService.create({
        data: { performerUserId: user.id, serviceId, serviceLevel: serviceId.split(".").length },
      });
    }
    performers.push({
      id: user.id,
      email: user.email,
      lat: city.lat,
      lng: city.lng,
      mode,
      radiusKm,
      services: [...serviceIds.keys()].map((serviceId) => {
        const parts = serviceId.split(".");
        return {
          categoryId: parts[0],
          subcategoryId: parts.length >= 2 ? `${parts[0]}.${parts[1]}` : serviceId,
          typeId: parts.length >= 3 ? serviceId : null,
        };
      }),
    });
  }
  return performers;
}

async function tokenFor(user: Customer | { id: string; email: string }, role: "customer" | "performer") {
  return signAccessToken({ userId: user.id, email: user.email, role });
}

/** Специфікації заказу, які вимагає каталог, заповнюються мінімально допустимими значеннями. */
function specsFor(level: ServiceLevel): Record<string, unknown> {
  const sub = getSubcategoryById(level.subcategoryId);
  const type = level.typeId ? getTypeById(level.typeId) : undefined;
  const required = [...(sub?.specs ?? []), ...(type?.specs ?? [])].filter((s) => s.required);
  const specs: Record<string, unknown> = {};
  for (const spec of required) {
    if (spec.type === "select") specs[spec.name] = (spec.options ?? [])[0];
    else if (spec.type === "number") specs[spec.name] = spec.min ?? 1;
    else specs[spec.name] = "тест";
  }
  return specs;
}

async function createOrder(customer: Customer, level: ServiceLevel, lat: number, lng: number, label: string) {
  const token = await tokenFor(customer, "customer");
  const body = {
    serviceCategoryId: level.categoryId,
    serviceSubCategoryId: level.subcategoryId,
    serviceTypeId: level.typeId,
    specs: specsFor(level),
    areaHa: 5 + Math.floor(rnd() * 300),
    budget: 3000 + Math.floor(rnd() * 50000),
    location: { lat, lng, addressLabel: `Тест, ${label}`, regionName: "Тестова область" },
    status: "published",
  };
  const req = new Request("http://localhost/api/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const res = await createOrderPost(req);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function randomUkrainePoint() {
  // Прямокутник може захопити сусідні країни: беремо лише точки всередині України.
  for (;;) {
    const lat = 46.6 + rnd() * 5.5;
    const lng = 22.2 + rnd() * 17.7;
    if (isWithinUkraine(lat, lng)) return { lat, lng };
  }
}

async function waitForQueue() {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379/9");
  const queue = new Queue("match-new-order", {
    connection: { host: url.hostname, port: Number(url.port || 6379), db: Number(url.pathname.slice(1) || 0) },
  });
  // Постановка в чергу відбувається асинхронно після відповіді API: короткий запас.
  await new Promise((r) => setTimeout(r, 300));
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const counts = await queue.getJobCounts("waiting", "active", "delayed");
      if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  } finally {
    await queue.close();
  }
}

/** Незалежний розрахунок: виконавець підходить, якщо збігається послуга і є покриття. */
function expectedPerformers(order: { lat: number; lng: number; serviceTypeId: string | null; serviceSubCategoryId: string; serviceCategoryId: string }, performers: Performer[]) {
  const orderServices = new Set([order.serviceTypeId, order.serviceSubCategoryId, order.serviceCategoryId].filter(Boolean));
  return performers
    .filter((p) => {
      const serviceMatch = p.services.some((s) => {
        const id = s.typeId ?? (s.subcategoryId && s.subcategoryId !== s.categoryId ? s.subcategoryId : s.categoryId);
        return orderServices.has(id);
      });
      if (!serviceMatch) return false;
      if (p.mode === "country") return true;
      return haversineKm(p.lat, p.lng, order.lat, order.lng) <= (p.radiusKm ?? 0);
    })
    .map((p) => p.id)
    .sort();
}

async function main() {
  console.log("1/6 Каталог послуг…");
  await seedCatalog();

  console.log("2/6 Виконавці (20) і заказчики (50)…");
  await prisma.user.deleteMany({ where: { email: { startsWith: "load-" } } });
  const performers = await seedPerformers();
  const customers = await createUsers("customer", CUSTOMERS_COUNT, "c");

  console.log("3/6 Створення заказів через POST /api/v1/orders…");
  const created: Array<{ orderId: string; kind: string }> = [];
  const failures: string[] = [];
  for (const [ci, customer] of customers.entries()) {
    for (let k = 0; k < ORDERS_PER_CUSTOMER; k++) {
      const level = pick(leaves);
      // Половина заказів — рядом з виконавцем (перевірка радіуса), половина — по всій Україні.
      let lat: number;
      let lng: number;
      let kind: string;
      if ((ci + k) % 2 === 0) {
        const near = pick(performers);
        const dist = rnd() * 180;
        const bearing = rnd() * Math.PI * 2;
        lat = near.lat + (dist * Math.cos(bearing)) / KM_PER_DEG_LAT;
        lng = near.lng + (dist * Math.sin(bearing)) / (KM_PER_DEG_LAT * Math.cos((near.lat * Math.PI) / 180));
        if (!isWithinUkraine(lat, lng)) {
          const fallback = randomUkrainePoint();
          lat = fallback.lat;
          lng = fallback.lng;
        }
        kind = `near-${near.mode === "country" ? "country" : near.radiusKm}`;
      } else {
        const p = randomUkrainePoint();
        lat = p.lat;
        lng = p.lng;
        kind = "random";
      }
      const res = await createOrder(customer, level, lat, lng, kind);
      if (res.status !== 201) {
        const details = JSON.stringify(res.body?.error?.details ?? res.body?.details ?? res.body ?? {});
        failures.push(`${customer.email} ${res.status} ${details} lat=${lat.toFixed(4)} lng=${lng.toFixed(4)} level=${JSON.stringify(level)}`);
        continue;
      }
      created.push({ orderId: res.body.data.order.id, kind });
    }
  }
  console.log(`   створено ${created.length} заказів, відмов ${failures.length}`);
  if (failures.length) console.log("   перші відмови:", failures.slice(0, 5));

  console.log("4/6 Очікування воркера match-new-order…");
  const drained = await waitForQueue();
  console.log(`   черга ${drained ? "порожня" : "НЕ спорожніла за час очікування"}`);

  console.log("5/6 Порівняння з незалежним розрахунком…");
  const orders = await prisma.order.findMany({
    where: { id: { in: created.map((c) => c.orderId) }, status: "published" },
    select: { id: true, lat: true, lng: true, serviceCategoryId: true, serviceSubCategoryId: true, serviceTypeId: true },
  });
  const matches = await prisma.orderMatch.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, status: { not: "refused" } },
    select: { orderId: true, performerUserId: true },
  });
  const actualByOrder = new Map<string, string[]>();
  for (const m of matches) actualByOrder.set(m.orderId, [...(actualByOrder.get(m.orderId) ?? []), m.performerUserId]);

  let mismatches = 0;
  let totalExpected = 0;
  let totalActual = 0;
  const missing: string[] = [];
  const extra: string[] = [];
  for (const order of orders) {
    const expected = expectedPerformers(order, performers);
    const actual = (actualByOrder.get(order.id) ?? []).sort();
    totalExpected += expected.length;
    totalActual += actual.length;
    const miss = expected.filter((id) => !actual.includes(id));
    const more = actual.filter((id) => !expected.includes(id));
    if (miss.length || more.length) {
      mismatches++;
      if (missing.length < 5) missing.push(`${order.id}: пропущено ${miss.length}`);
      if (extra.length < 5) extra.push(`${order.id}: зайвих ${more.length}`);
    }
  }
  console.log(`   заказів опубліковано: ${orders.length}`);
  console.log(`   очікуваних пар: ${totalExpected}, фактичних: ${totalActual}`);
  console.log(`   заказів з розбіжністю: ${mismatches}`, missing.length ? missing : "", extra.length ? extra : "");

  console.log("6/6 Біржа виконавця (GET /api/v1/marketplace/orders) для 3 виконавців…");
  for (const p of performers.slice(0, 3)) {
    const token = await tokenFor({ id: p.id, email: p.email }, "performer");
    const res = await marketplaceGet(
      new Request("http://localhost/api/v1/marketplace/orders?limit=100", {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    const body = (await res.json()) as { data: { items: Array<{ id: string }> } };
    const shown = body.data.items.map((i) => i.id).filter((id) => created.some((c) => c.orderId === id)).sort();
    const expectedIds = orders
      .filter((o) => expectedPerformers(o, performers).includes(p.id))
      .map((o) => o.id)
      .sort();
    const ok = JSON.stringify(shown) === JSON.stringify(expectedIds);
    console.log(`   ${p.email}: на біржі ${shown.length}, очікувано ${expectedIds.length} — ${ok ? "OK" : "РОЗБІЖНІСТЬ"}`);
  }

  console.log("Граничний випадок: виконавець Київ, радіус 150 км, заказ на 149 і 151 км…");
  const boundaryUser = await prisma.user.create({
    data: { role: "performer", name: "Load boundary", email: "load-boundary@test.local", passwordHash: "x", updatedAt: new Date() },
    select: { id: true, email: true },
  });
  await prisma.performerProfile.create({
    data: {
      userId: boundaryUser.id,
      baseLatitude: 50.4501,
      baseLongitude: 30.5234,
      baseLocationLabel: "Київ",
      coverageMode: "radius",
      coverageRadiusKm: 150,
      updatedAt: new Date(),
    },
  });
  await prisma.performerService.create({
    data: { performerUserId: boundaryUser.id, serviceId: "1", serviceLevel: 1 },
  });
  const boundaryCustomer = customers[0];
  const boundaryLevel: ServiceLevel = { categoryId: "1", subcategoryId: "1.1", typeId: null };
  const near = { lat: 50.4501 + 149 / KM_PER_DEG_LAT, lng: 30.5234 };
  const far = { lat: 50.4501 + 151 / KM_PER_DEG_LAT, lng: 30.5234 };
  const nearRes = await createOrder(boundaryCustomer, boundaryLevel, near.lat, near.lng, "boundary-149");
  const farRes = await createOrder(boundaryCustomer, boundaryLevel, far.lat, far.lng, "boundary-151");
  await waitForQueue();
  const nearMatched = await prisma.orderMatch.count({
    where: { orderId: nearRes.body.data.order.id, performerUserId: boundaryUser.id, status: { not: "refused" } },
  });
  const farMatched = await prisma.orderMatch.count({
    where: { orderId: farRes.body.data.order.id, performerUserId: boundaryUser.id, status: { not: "refused" } },
  });
  console.log(`   149 км (${haversineKm(50.4501, 30.5234, near.lat, near.lng).toFixed(1)} км): ${nearMatched ? "підходить" : "НЕ підходить"}`);
  console.log(`   151 км (${haversineKm(50.4501, 30.5234, far.lat, far.lng).toFixed(1)} км): ${farMatched ? "ПІДХОДИТЬ (помилка)" : "не підходить"}`);

  if (mismatches > 0 || failures.length > 0 || !drained) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Відкриті з'єднання Redis із модулів черг не дають Node завершитися самостійно.
    process.exit(process.exitCode ?? 0);
  });
