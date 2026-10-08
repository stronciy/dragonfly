const BASE = process.env.BACKEND_URL ?? "http://localhost:3000";

let failures = 0;

async function api(path, { method = "GET", token, body, expect = 200 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (res.status !== expect) {
    failures += 1;
    console.error(
      `FAIL ${method} ${path}: expected ${expect}, got ${res.status}`,
      JSON.stringify(json)?.slice(0, 600)
    );
    return { status: res.status, json, ok: false };
  }
  console.log(`ok ${method} ${path} -> ${res.status}`);
  return { status: res.status, json, ok: true };
}

function check(name, cond, extra) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`, extra ?? "");
  } else {
    console.log(`ok ${name}`);
  }
}

function makeUaIban(bankCode6, account19) {
  const bban = `${bankCode6}${account19}`;
  const rearranged = `${bban}UA00`;
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  const checkDigits = String(98 - remainder).padStart(2, "0");
  return `UA${checkDigits}${bban}`;
}

const PASS = "Test1234";

const performer1 = {
  email: "stronciy+10@gmail.com",
  password: PASS,
  name: "Олександр Полтава",
  phone: "+380671000010",
  role: "performer",
  settings: {
    baseLocationLabel: "Poltava",
    baseCoordinate: { lat: 49.5883, lng: 34.5514 },
    coverage: { mode: "radius", radiusKm: 70 },
    services: ["1.1", "1.3"],
  },
  legal: {
    companyName: 'ТОВ "Полтава Агро Тест"',
    edrpou: "10000010",
    iban: makeUaIban("300001", "0000000000000000001"),
    legalAddress: "м. Полтава, вул. Тестова, 10",
    vatPayer: false,
  },
};

const performer2 = {
  email: "stronciy11@gmail.com",
  password: PASS,
  name: "Богдан Київ",
  phone: "+380671000011",
  role: "performer",
  settings: {
    baseLocationLabel: "Kyiv",
    baseCoordinate: { lat: 50.4501, lng: 30.5234 },
    coverage: { mode: "radius", radiusKm: 100 },
    services: ["3.1", "3.2"],
  },
  legal: {
    companyName: 'ТОВ "Київ Агро Тест"',
    edrpou: "10000011",
    iban: makeUaIban("300002", "0000000000000000002"),
    legalAddress: "м. Київ, вул. Тестова, 11",
    vatPayer: false,
  },
};

const customer = {
  email: "stronciy+20@gmail.com",
  password: PASS,
  name: "Замовник Тест",
  phone: "+380671000020",
  role: "customer",
  legal: {
    companyName: "ФОП Тест Замовник",
    edrpou: "10000020",
    iban: makeUaIban("300003", "0000000000000000003"),
    legalAddress: "м. Полтава, вул. Замовника, 20",
    vatPayer: false,
  },
};

async function registerLogin(u) {
  const reg = await api("/api/v1/auth/register", {
    method: "POST",
    body: { name: u.name, email: u.email, password: u.password },
    expect: 201,
  });
  check(`register ${u.email}`, !!reg.json?.data?.user?.id);
  const login = await api("/api/v1/auth/login", {
    method: "POST",
    body: { email: u.email, password: u.password },
  });
  const token = login.json?.data?.accessToken;
  check(`login ${u.email}`, !!token);
  return token;
}

async function main() {
  const t1 = await registerLogin(performer1);
  const t2 = await registerLogin(performer2);
  const tc = await registerLogin(customer);

  for (const [token, u] of [[t1, performer1], [t2, performer2], [tc, customer]]) {
    const me = await api("/api/v1/users/me", {
      method: "PATCH",
      token,
      body: { name: u.name, phone: u.phone },
    });
    check(`profile ${u.email}`, me.json?.data?.user?.phone === u.phone);

    if (u.role === "performer") {
      const r = await api("/api/v1/users/me/role", { method: "PATCH", token, body: { role: "performer" } });
      check(`role performer ${u.email}`, r.json?.data?.user?.role === "performer");
    }

    const legal = await api("/api/v1/users/me/legal-profile", { method: "PATCH", token, body: u.legal });
    check(`legal ${u.email}`, legal.ok && legal.json?.data?.legalProfile?.edrpou === u.legal.edrpou);
  }

  for (const [token, u] of [[t1, performer1], [t2, performer2]]) {
    const s = await api("/api/v1/performer/settings", { method: "PUT", token, body: u.settings });
    check(`settings ${u.email}`, s.ok);
    const g = await api("/api/v1/performer/settings", { token });
    const got = g.json?.data?.settings;
    check(
      `settings verify ${u.email}`,
      got?.coverage?.radiusKm === u.settings.coverage.radiusKm &&
        JSON.stringify([...got.services].sort()) === JSON.stringify([...u.settings.services].sort())
    );
  }

  const o1 = await api("/api/v1/orders", {
    expect: 201,
    method: "POST",
    token: tc,
    body: {
      serviceCategoryId: "1",
      serviceSubCategoryId: "1.1",
      specs: {},
      areaHa: 10,
      location: { lat: 49.6, lng: 34.6, addressLabel: "Поле 1", regionName: "Poltava" },
      budget: 10000,
      comment: "Тестове замовлення 1 (Полтава, дискування)",
      status: "published",
    },
  });
  const order1Id = o1.json?.data?.order?.id;
  check("order1 published", o1.ok && o1.json?.data?.order?.status === "published");

  const o2 = await api("/api/v1/orders", {
    expect: 201,
    method: "POST",
    token: tc,
    body: {
      serviceCategoryId: "3",
      serviceSubCategoryId: "3.1",
      specs: { "Ширина внесення штанги (м)": 6 },
      areaHa: 15,
      location: { lat: 50.5, lng: 30.6, addressLabel: "Поле 2", regionName: "Kyiv" },
      budget: 15000,
      comment: "Тестове замовлення 2 (Київ, дрони)",
      status: "published",
    },
  });
  const order2Id = o2.json?.data?.order?.id;
  check("order2 published", o2.ok && o2.json?.data?.order?.status === "published");

  await new Promise((r) => setTimeout(r, 3000));

  const mkt1 = await api("/api/v1/marketplace/orders", { token: t1 });
  const ids1 = (mkt1.json?.data?.items ?? []).map((o) => o.id ?? o.orderId);
  check("performer1 sees order1", ids1.includes(order1Id), ids1.slice(0, 5));

  const mkt2 = await api("/api/v1/marketplace/orders", { token: t2 });
  const ids2 = (mkt2.json?.data?.items ?? []).map((o) => o.id ?? o.orderId);
  check("performer2 sees order2", ids2.includes(order2Id), ids2.slice(0, 5));

  console.log(JSON.stringify({ order1Id, order2Id }, null, 2));

  if (failures > 0) {
    console.error(`SEED FAILED with ${failures} failures`);
    process.exit(1);
  }
  console.log("SEED PASSED");
}

main().catch((e) => {
  console.error("SEED ERROR", e);
  process.exit(1);
});
