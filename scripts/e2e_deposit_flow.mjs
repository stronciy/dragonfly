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
      JSON.stringify(json)?.slice(0, 500)
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

const email = (r) => `e2e_${r}_${Date.now()}@example.com`;

const customer = { email: email("cust"), password: "secret123", name: "E2E Customer" };
const performer = { email: email("perf"), password: "secret123", name: "E2E Performer" };
const performer2 = { email: email("perf2"), password: "secret123", name: "E2E Performer 2" };

async function registerAndLogin(u) {
  const reg = await api("/api/v1/auth/register", { method: "POST", body: u, expect: 201 });
  check("register returns user", !!reg.json?.data?.user?.id);
  const login = await api("/api/v1/auth/login", {
    method: "POST",
    body: { email: u.email, password: u.password },
  });
  return login.json.data.accessToken;
}

async function main() {
  const customerToken = await registerAndLogin(customer);
  const performerToken = await registerAndLogin(performer);
  const performer2Token = await registerAndLogin(performer2);

  for (const [token, role] of [[performerToken, "performer"], [performer2Token, "performer"]]) {
    const r = await api("/api/v1/users/me/role", { method: "PATCH", token, body: { role } });
    check(`switchRole -> ${role}`, r.json?.data?.user?.role === role);
  }

  const catalog = await api("/api/v1/catalog/services", { token: customerToken });
  const cat = catalog.json?.data?.categories?.[0];
  check("catalog has category", !!cat);
  const sub = cat?.subcategories?.[0];
  const subId = typeof sub === "string" ? sub : sub?.serviceSubCategoryId;
  const typeEntry = sub?.types?.[0];
  const typeId = typeof typeEntry === "string" ? typeEntry : typeEntry?.serviceTypeId;

  const settings = await api("/api/v1/performer/settings", {
    method: "PUT",
    token: performerToken,
    body: {
      baseLocationLabel: "Poltava",
      baseCoordinate: { lat: 49.5883, lng: 34.5514 },
      coverage: { mode: "country" },
      services: [subId].filter(Boolean),
    },
  });
  check("performer settings saved", settings.ok);

  async function createOrder() {
    const r = await api("/api/v1/orders", {
      expect: 201,
      method: "POST",
      token: customerToken,
      body: {
        serviceCategoryId: cat.serviceCategoryId,
        ...(subId ? { serviceSubCategoryId: typeof subId === "string" ? subId : subId.id } : {}),
        ...(typeId ? { serviceTypeId: typeId } : {}),
        specs: {},
        areaHa: 10,
        location: { lat: 49.58, lng: 34.55, addressLabel: "Field 1", regionName: "Poltava" },
        budget: 10000,
        status: "published",
      },
    });
    check("order published", r.json?.data?.order?.status === "published");
    return r.json.data.order.id;
  }

  async function liqpayConfirm(token, intent) {
    const pi = intent.paymentIntent ?? intent;
    const r = await api(`/api/v1/payments/${pi.id}/confirm`, {
      method: "POST",
      token,
      body: { providerPayload: { provider: "liqpay", data: pi.data, signature: pi.signature } },
    });
    return r;
  }

  const orderId = await createOrder();

  const badIntent = await api(`/api/v1/orders/${orderId}/deposits/customer-intent`, {
    method: "POST",
    token: customerToken,
    body: {},
    expect: 400,
  });
  check("customer-intent on published -> 400", badIntent.ok);

  const pIntent = await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, {
    method: "POST",
    token: performerToken,
    body: { method: "card", resultUrl: "liqpay://result" },
  });
  const pIntentId = pIntent.json?.data?.paymentIntent?.id;
  check("performer intent created", !!pIntentId);

  const detail = await api(`/api/v1/marketplace/orders/${orderId}`, { token: performerToken });
  check("detail after claim (assigned)", detail.json?.data?.order?.status === "accepted");

  const conflict = await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, {
    method: "POST",
    token: performer2Token,
    body: {},
    expect: 409,
  });
  check("second performer claim -> 409", conflict.ok);

  const pConfirm = await liqpayConfirm(performerToken, pIntent.json.data);
  check("performer deposit -> requires_confirmation", pConfirm.json?.data?.order?.status === "requires_confirmation");

  const pConfirmDup = await liqpayConfirm(performerToken, pIntent.json.data);
  check("performer double confirm idempotent", pConfirmDup.json?.data?.order?.status === "requires_confirmation");

  const badSig = await api(`/api/v1/payments/${pIntentId}/confirm`, {
    method: "POST",
    token: performerToken,
    body: { providerPayload: { provider: "liqpay", data: "x", signature: "y" } },
  });
  check("confirm on paid intent is idempotent (200, no double transition)", badSig.ok && badSig.json?.data?.order?.status === "requires_confirmation");

  const cIntent = await api(`/api/v1/orders/${orderId}/deposits/customer-intent`, {
    method: "POST",
    token: customerToken,
    body: { method: "card", resultUrl: "liqpay://result" },
  });
  check("customer intent created", !!cIntent.json?.data?.paymentIntent?.id);

  const cConfirm = await liqpayConfirm(customerToken, cIntent.json.data);
  check("customer deposit -> confirmed", cConfirm.json?.data?.order?.status === "confirmed");

  const started = await api(`/api/v1/orders/${orderId}/status`, {
    method: "PATCH",
    token: performerToken,
    body: { status: "started" },
  });
  check("started", started.json?.data?.order?.status === "started");

  const completed = await api(`/api/v1/orders/${orderId}/status`, {
    method: "PATCH",
    token: performerToken,
    body: { status: "completed" },
  });
  check("completed", completed.json?.data?.order?.status === "completed");

  const accepted = await api(`/api/v1/orders/${orderId}/confirm-completion`, {
    method: "POST",
    token: customerToken,
    body: { accepted: true, rating: 5, comment: "Good job" },
  });
  check("confirm-completion accepted", accepted.ok);

  const disputeOrderId = await createOrder();
  const dIntent = await api(`/api/v1/marketplace/orders/${disputeOrderId}/deposits/performer-intent`, {
    method: "POST",
    token: performerToken,
    body: {},
  });
  const dBad = await api(`/api/v1/payments/${dIntent.json.data.paymentIntent.id}/confirm`, {
    method: "POST",
    token: performerToken,
    body: { providerPayload: { provider: "liqpay", data: "tampered", signature: "invalid" } },
    expect: 400,
  });
  check("tampered signature on pending intent -> 400", dBad.ok);
  await liqpayConfirm(performerToken, dIntent.json.data);
  const dcIntent = await api(`/api/v1/orders/${disputeOrderId}/deposits/customer-intent`, {
    method: "POST",
    token: customerToken,
    body: {},
  });
  await liqpayConfirm(customerToken, dcIntent.json.data);
  await api(`/api/v1/orders/${disputeOrderId}/status`, {
    method: "PATCH",
    token: performerToken,
    body: { status: "started" },
  });
  const arb = await api(`/api/v1/orders/${disputeOrderId}/arbitration`, {
    method: "POST",
    token: customerToken,
    body: { reason: "E2E dispute" },
  });
  check("arbitration", arb.ok);

  const refuseOrderId = await createOrder();
  const rIntent = await api(`/api/v1/marketplace/orders/${refuseOrderId}/deposits/performer-intent`, {
    method: "POST",
    token: performerToken,
    body: {},
  });
  await liqpayConfirm(performerToken, rIntent.json.data);
  const refuse = await api(`/api/v1/orders/${refuseOrderId}/refuse`, {
    method: "POST",
    token: performerToken,
    body: { reason: "E2E refuse test" },
  });
  check("refuse -> published", refuse.json?.data?.order?.status === "published");
  check("refuse forfeited (customer paid? no, performer only)", refuse.json?.data?.forfeited === false);

  const refuseOrderId2 = await createOrder();
  const r2Intent = await api(`/api/v1/marketplace/orders/${refuseOrderId2}/deposits/performer-intent`, {
    method: "POST",
    token: performerToken,
    body: {},
  });
  await liqpayConfirm(performerToken, r2Intent.json.data);
  const r2cIntent = await api(`/api/v1/orders/${refuseOrderId2}/deposits/customer-intent`, {
    method: "POST",
    token: customerToken,
    body: {},
  });
  await liqpayConfirm(customerToken, r2cIntent.json.data);
  const refuse2 = await api(`/api/v1/orders/${refuseOrderId2}/refuse`, {
    method: "POST",
    token: performerToken,
    body: { reason: "E2E refuse after customer paid" },
  });
  check("refuse after customer paid -> published + forfeited", refuse2.json?.data?.order?.status === "published" && refuse2.json?.data?.forfeited === true);

  const cancelOrderId = await createOrder();
  const delDraft = await api(`/api/v1/orders/${cancelOrderId}`, { method: "DELETE", token: customerToken });
  check("delete published", delDraft.ok);

  if (failures > 0) {
    console.error(`E2E FAILED with ${failures} failures`);
    process.exit(1);
  }
  console.log("E2E PASSED");
}

main().catch((e) => {
  console.error("E2E ERROR", e);
  process.exit(1);
});
