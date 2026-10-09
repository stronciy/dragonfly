import { execFileSync } from "node:child_process";
import "dotenv/config";
import { getAllServiceIds } from "../services-tree";

const BASE = process.env.BACKEND_URL ?? "http://localhost:3000";
const PASSWORD = "Test1234";
const TEST_IBAN = "UA213996220000026007233566001";

type TestPerformer = {
  email: string;
  name: string;
  phone: string;
  edrpou: string;
  baseLocationLabel: string;
  lat: number;
  lng: number;
  radiusKm: number;
};

const PERFORMERS: TestPerformer[] = [
  {
    email: "stronciy+10@gmail.com",
    name: "TEST Виконавець Полтава",
    phone: "+380501112210",
    edrpou: "10000010",
    baseLocationLabel: "Полтава",
    lat: 49.5883,
    lng: 34.5514,
    radiusKm: 100,
  },
  {
    email: "stronciy+20@gmail.com",
    name: "TEST Виконавець Вінниця",
    phone: "+380501112220",
    edrpou: "20000020",
    baseLocationLabel: "Вінниця",
    lat: 49.2331,
    lng: 28.4682,
    radiusKm: 150,
  },
];

function databaseHost(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new URL(url.replace(/^postgres(ql)?:/, "http:")).hostname;
}

function assertConfirmed() {
  const host = databaseHost();
  const confirmed = process.env.CONFIRM_WIPE_HOST;
  if (confirmed !== host) {
    throw new Error(
      `Refusing to wipe. DATABASE_URL host is "${host}". ` +
        `Re-run with CONFIRM_WIPE_HOST=${host} to confirm the wipe target.`
    );
  }
  console.log(`target database host "${host}", backend ${BASE}`);
}

function resetDatabase() {
  execFileSync("npm", ["run", "db:reset"], { stdio: "inherit", env: process.env });
}

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

async function seedPerformer(p: TestPerformer, serviceIds: string[]) {
  console.log(`\n=== ${p.email} ===`);

  const reg = await api("/api/v1/auth/register", {
    method: "POST",
    body: { name: p.name, email: p.email, password: PASSWORD },
  });
  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)?.slice(0, 300)}`);
  }

  const login = await api("/api/v1/auth/login", {
    method: "POST",
    body: { email: p.email, password: PASSWORD },
  });
  const token = login.json?.data?.accessToken as string | undefined;
  if (login.status !== 200 || !token) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.json)?.slice(0, 300)}`);
  }

  const role = await api("/api/v1/users/me/role", { method: "PATCH", token, body: { role: "performer" } });
  console.log(`role -> performer: ${role.status}`);

  const me = await api("/api/v1/users/me", {
    method: "PATCH",
    token,
    body: { name: p.name, phone: p.phone },
  });
  console.log(`name/phone -> ${me.status}`);

  const settings = await api("/api/v1/performer/settings", {
    method: "PUT",
    token,
    body: {
      baseLocationLabel: p.baseLocationLabel,
      baseCoordinate: { lat: p.lat, lng: p.lng },
      coverage: { mode: "radius", radiusKm: p.radiusKm },
      services: serviceIds,
    },
  });
  if (settings.status !== 200) {
    throw new Error(`settings failed: ${JSON.stringify(settings.json)?.slice(0, 500)}`);
  }
  console.log(`settings -> 200, services sent: ${serviceIds.length}`);

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
  console.log(`legal profile -> ${legal.status}`);

  const verify = await api("/api/v1/performer/settings", { token });
  const saved = verify.json?.data?.settings?.services?.length ?? "?";
  console.log(`verify: services saved=${saved}`);
}

async function main() {
  assertConfirmed();
  if (process.env.SKIP_DB_RESET === "1") {
    console.log("SKIP_DB_RESET=1: database reset skipped, seeding only");
  } else {
    resetDatabase();
  }

  const { categories, subcategories, types } = getAllServiceIds();
  const serviceIds = [...new Set([...categories, ...subcategories, ...types])];
  console.log(`\nall service activities: ${serviceIds.length}`);

  for (const p of PERFORMERS) {
    await seedPerformer(p, serviceIds);
  }
  console.log("\ndone");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
