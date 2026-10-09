/**
 * Seed TEST performers on the target API (default: production).
 * Idempotent: safe to re-run (register 409 -> login, everything else upserts).
 *
 * Usage: BACKEND_URL=https://api.dragonfly.ua npx tsx scripts/seed_test_performers.ts
 */
import { getAllServiceIds } from "../services-tree";

const BASE = process.env.BACKEND_URL ?? "http://localhost:3000";
const PASSWORD = "Test1234";
const TEST_IBAN = "UA213996220000026007233566001"; // valid checksum test IBAN

type TestPerformer = {
  email: string;
  name: string;
  phone: string;
  baseLocationLabel: string;
  lat: number;
  lng: number;
  mode: "radius" | "country";
  radiusKm: number | null;
  edrpou: string;
};

const PERFORMERS: TestPerformer[] = [
  {
    email: "stronciy+30@gmail.com",
    name: "TEST Виконавець Полтава",
    phone: "+380501112230",
    baseLocationLabel: "Полтава",
    lat: 49.5883,
    lng: 34.5514,
    mode: "radius",
    radiusKm: 100,
    edrpou: "30000001",
  },
  {
    email: "stronciy+31@gmail.com",
    name: "TEST Виконавець Вінниця",
    phone: "+380501112231",
    baseLocationLabel: "Вінниця",
    lat: 49.2331,
    lng: 28.4682,
    mode: "radius",
    radiusKm: 150,
    edrpou: "31000001",
  },
  {
    email: "stronciy+32@gmail.com",
    name: "TEST Виконавець Україна",
    phone: "+380501112232",
    baseLocationLabel: "Київ",
    lat: 50.4501,
    lng: 30.5234,
    mode: "country",
    radiusKm: null,
    edrpou: "32000001",
  },
];

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

async function main() {
  const { categories, subcategories, types } = getAllServiceIds();
  const allServices = [...categories, ...subcategories, ...types];
  console.log(`services to assign: ${allServices.length}`);

  for (const p of PERFORMERS) {
    console.log(`\n=== ${p.email} ===`);

    // 1. register (409 = already exists -> login)
    const reg = await api("/api/v1/auth/register", {
      method: "POST",
      body: { name: p.name, email: p.email, password: PASSWORD },
    });
    console.log(`register -> ${reg.status}`);

    // 2. login
    const login = await api("/api/v1/auth/login", {
      method: "POST",
      body: { email: p.email, password: PASSWORD },
    });
    if (login.status !== 200 || !login.json?.data?.accessToken) {
      throw new Error(`login failed: ${login.status} ${JSON.stringify(login.json)?.slice(0, 300)}`);
    }
    const token = login.json.data.accessToken as string;
    console.log(`login -> 200 (role: ${login.json.data?.user?.role})`);

    // 3. switch to performer
    const role = await api("/api/v1/users/me/role", {
      method: "PATCH",
      token,
      body: { role: "performer" },
    });
    console.log(`role -> performer: ${role.status}`);

    // 4. name + phone
    const me = await api("/api/v1/users/me", {
      method: "PATCH",
      token,
      body: { name: p.name, phone: p.phone },
    });
    console.log(`me (name/phone) -> ${me.status}`);

    // 5. performer settings: base + coverage + ALL services
    const settings = await api("/api/v1/performer/settings", {
      method: "PUT",
      token,
      body: {
        baseLocationLabel: p.baseLocationLabel,
        baseCoordinate: { lat: p.lat, lng: p.lng },
        coverage: { mode: p.mode, radiusKm: p.radiusKm },
        services: allServices,
      },
    });
    console.log(`settings -> ${settings.status}`);
    if (settings.status !== 200) {
      console.error(`settings FAILED: ${JSON.stringify(settings.json)?.slice(0, 500)}`);
      continue;
    }

    // 6. legal profile (clearly marked TEST)
    const legal = await api("/api/v1/users/me/legal-profile", {
      method: "PATCH",
      token,
      body: {
        companyName: `TEST ${p.name}`,
        edrpou: p.edrpou,
        iban: TEST_IBAN,
        vatPayer: false,
      },
    });
    console.log(`legal -> ${legal.status}`);

    // 7. verify
    const verify = await api("/api/v1/performer/settings", { token });
    const count = verify.json?.data?.settings?.services?.length ?? "?";
    console.log(`verify: services=${count}`);
  }
  console.log("\ndone");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
