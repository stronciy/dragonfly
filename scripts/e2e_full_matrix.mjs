import { execFileSync } from "node:child_process";
import { Queue } from "bullmq";

const BASE = process.env.BACKEND_URL ?? "http://localhost:3000";
const DB = "postgresql://dragonfly:dragonfly@localhost:55432/dragonfly";
let failures = 0;
let scenario = "";

function sql(q) {
  return execFileSync("psql", [DB, "-tA", "-c", q], { encoding: "utf8" }).trim();
}

async function api(path, { method = "GET", token, body, expect = 200, form } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(form ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const json = await res.json().catch(() => null);
  if (res.status !== expect) {
    failures += 1;
    console.error(`FAIL [${scenario}] ${method} ${path}: expected ${expect}, got ${res.status}`, JSON.stringify(json)?.slice(0, 400));
    return { status: res.status, json, ok: false };
  }
  console.log(`ok [${scenario}] ${method} ${path} -> ${res.status}`);
  return { status: res.status, json, ok: true };
}

function check(name, cond, extra) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL [${scenario}] ${name}`, extra ?? "");
  } else {
    console.log(`ok [${scenario}] ${name}`);
  }
}

const email = (r) => `matrix_${r}_${Date.now()}@example.com`;
const lockStatus = (orderId) =>
  sql(`SELECT role||':'||status FROM escrow_locks WHERE order_id='${orderId}' ORDER BY role;`);

async function registerAndLogin(u, role) {
  await api("/api/v1/auth/register", { method: "POST", body: u, expect: 201 });
  const login = await api("/api/v1/auth/login", { method: "POST", body: { email: u.email, password: u.password } });
  const token = login.json.data.accessToken;
  if (role) await api("/api/v1/users/me/role", { method: "PATCH", token, body: { role } });
  return token;
}

let CAT = null;
async function setupUsers() {
  const customerToken = await registerAndLogin({ email: email("cust"), password: "secret123", name: "M Customer" });
  const performerToken = await registerAndLogin({ email: email("perf"), password: "secret123", name: "M Performer" }, "performer");
  const catalog = await api("/api/v1/catalog/services", { token: customerToken });
  const cat = catalog.json?.data?.categories?.[0];
  const sub = cat?.subcategories?.[0];
  const subId = typeof sub === "string" ? sub : sub?.serviceSubCategoryId;
  CAT = { cat, subId };
  await api("/api/v1/performer/settings", {
    method: "PUT", token: performerToken,
    body: { baseLocationLabel: "Poltava", baseCoordinate: { lat: 49.5883, lng: 34.5514 }, coverage: { mode: "country" }, services: [subId].filter(Boolean) },
  });
  return { customerToken, performerToken };
}

async function createOrder(token, extra = {}) {
  const r = await api("/api/v1/orders", {
    expect: 201, method: "POST", token,
    body: {
      serviceCategoryId: CAT.cat.serviceCategoryId,
      ...(CAT.subId ? { serviceSubCategoryId: typeof CAT.subId === "string" ? CAT.subId : CAT.subId.id } : {}),
      specs: {}, areaHa: 10,
      location: { lat: 49.58, lng: 34.55, addressLabel: "Field M", regionName: "Poltava" },
      budget: 10000, status: "published", ...extra,
    },
  });
  return r.json.data.order.id;
}

async function payDeposit(token, intentData) {
  const pi = intentData.paymentIntent ?? intentData;
  return api(`/api/v1/payments/${pi.id}/confirm`, {
    method: "POST", token,
    body: { providerPayload: { provider: "liqpay", data: pi.data, signature: pi.signature } },
  });
}

async function fullDeposits(customerToken, performerToken, orderId) {
  const pIntent = await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, { method: "POST", token: performerToken, body: { method: "card" } });
  await payDeposit(performerToken, pIntent.json.data);
  const cIntent = await api(`/api/v1/orders/${orderId}/deposits/customer-intent`, { method: "POST", token: customerToken, body: { method: "card" } });
  await payDeposit(customerToken, cIntent.json.data);
  const st = await api(`/api/v1/orders/${orderId}`, { token: customerToken });
  check("both deposits -> confirmed", st.json?.data?.order?.status === "confirmed", st.json?.data?.order?.status);
}

const conn = { host: "localhost", port: 6379 };
async function enqueue(queue, payload) {
  const q = new Queue(queue, { connection: conn });
  await q.add("job", payload);
  await q.close();
}

async function main() {
  const { customerToken, performerToken } = await setupUsers();

  // S1: happy plain
  scenario = "S1 happy plain";
  {
    const orderId = await createOrder(customerToken);
    await fullDeposits(customerToken, performerToken, orderId);
    check("locks held x2", lockStatus(orderId) === "customer:held\nperformer:held", lockStatus(orderId));
    const srv = sql(`SELECT count(*) FROM payment_intents WHERE order_id='${orderId}' AND server_url IS NULL;`);
    check("intents carry serverUrl", srv === "0", srv);
    await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "started" } });
    await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "completed" } });
    await api(`/api/v1/orders/${orderId}/confirm-completion`, { method: "POST", token: customerToken, body: { accepted: true, rating: 5, comment: "Good" } });
    check("locks released x2", lockStatus(orderId) === "customer:released\nperformer:released", lockStatus(orderId));
    const det = await api(`/api/v1/orders/${orderId}`, { token: customerToken });
    check("completionConfirmedAt set", !!det.json?.data?.order?.completionConfirmedAt, JSON.stringify(det.json?.data?.order)?.slice(0, 120));
    const nb = await api(`/api/v1/notifications?role=customer`, { token: customerToken });
    const singles = (nb.json?.data?.items ?? []).filter((n) => n?.data?.type === "deposit_customer_required");
    check("inbox single deposit_customer_required", singles.length === 1, singles.length);
    // performer rating hidden until mutual
    const pr0 = await api(`/api/v1/performer/rating`, { token: performerToken });
    check("performer rating hidden (0) before mutual", pr0.json?.data?.rating?.count === 0, JSON.stringify(pr0.json?.data?.rating));
    globalThis.S1_ORDER = orderId;
  }

  // S14: mutual ratings visibility
  scenario = "S14 mutual ratings";
  {
    const orderId = globalThis.S1_ORDER;
    await api(`/api/v1/orders/${orderId}/reviews`, { method: "POST", token: performerToken, body: { rating: 4, comment: "OK" }, expect: 201 });
    const pr1 = await api(`/api/v1/performer/rating`, { token: performerToken });
    check("performer rating visible (1) after mutual", pr1.json?.data?.rating?.count === 1, JSON.stringify(pr1.json?.data?.rating));
    const cr = await api(`/api/v1/users/me/customer-rating`, { token: customerToken });
    check("customer rating visible (1)", cr.json?.data?.rating?.count === 1, JSON.stringify(cr.json?.data?.rating));
    const dup = await api(`/api/v1/orders/${orderId}/reviews`, { method: "POST", token: performerToken, body: { rating: 5 }, expect: 409 });
    check("double review -> 409", dup.ok);
  }

  // S2: happy with fine
  scenario = "S2 confirm with fine";
  {
    const orderId = await createOrder(customerToken);
    await fullDeposits(customerToken, performerToken, orderId);
    await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "started" } });
    await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "completed" } });
    await api(`/api/v1/orders/${orderId}/confirm-completion`, { method: "POST", token: customerToken, body: { accepted: true, rating: 4, fine: true } });
    check("fine: performer forfeited + customer released", lockStatus(orderId) === "customer:released\nperformer:forfeited", lockStatus(orderId));
  }

  // S3: cancel before accept
  scenario = "S3 cancel before accept";
  {
    const orderId = await createOrder(customerToken);
    const r = await api(`/api/v1/orders/${orderId}/cancel`, { method: "PATCH", token: customerToken, body: { reason: "changed mind" } });
    check("cancelled", r.json?.data?.order?.status === "cancelled");
    check("no locks", lockStatus(orderId) === "");
  }

  // S5: refuse before customer paid
  scenario = "S5 refuse before customer paid";
  {
    const orderId = await createOrder(customerToken);
    await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, { method: "POST", token: performerToken, body: {} });
    const r = await api(`/api/v1/orders/${orderId}/refuse`, { method: "POST", token: performerToken, body: { reason: "busy week" } });
    check("refuse -> published, forfeited=false", r.json?.data?.order?.status === "published" && r.json?.data?.forfeited === false);
  }

  // S6: refuse after customer paid
  scenario = "S6 refuse after customer paid";
  {
    const orderId = await createOrder(customerToken);
    await fullDeposits(customerToken, performerToken, orderId);
    const r = await api(`/api/v1/orders/${orderId}/refuse`, { method: "POST", token: performerToken, body: { reason: "tractor broken" } });
    check("refuse -> published, forfeited=true", r.json?.data?.order?.status === "published" && r.json?.data?.forfeited === true);
    check("performer forfeited", lockStatus(orderId).includes("performer:forfeited"), lockStatus(orderId));
    check("customer released", lockStatus(orderId).includes("customer:released"), lockStatus(orderId));
  }

  // S4: cancel after accept (deadline forced past)
  scenario = "S4 cancel after accept (expired)";
  {
    const orderId = await createOrder(customerToken);
    await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, { method: "POST", token: performerToken, body: {} });
    sql(`UPDATE orders SET deposit_deadline=NOW()-INTERVAL '1 hour' WHERE id='${orderId}';`);
    const r = await api(`/api/v1/orders/${orderId}/cancel`, { method: "PATCH", token: customerToken, body: {} });
    check("cancelled after expiry", r.json?.data?.order?.status === "cancelled");
  }

  // S7: deposit timeout (customer never pays)
  scenario = "S7 deposit deadline timeout";
  {
    const orderId = await createOrder(customerToken);
    const pIntent = await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, { method: "POST", token: performerToken, body: {} });
    await payDeposit(performerToken, pIntent.json.data);
    sql(`UPDATE orders SET deposit_deadline=NOW()-INTERVAL '1 hour' WHERE id='${orderId}';`);
    await enqueue("deposit-deadline-timeout", { orderId });
    await new Promise((r) => setTimeout(r, 4000));
    const st = await api(`/api/v1/orders/${orderId}`, { token: customerToken });
    check("timeout -> published", st.json?.data?.order?.status === "published", st.json?.data?.order?.status);
    check("performer lock refunded", lockStatus(orderId).includes("performer:refunded"), lockStatus(orderId));
  }

  // S8: expired (accepted, nobody paid)
  scenario = "S8 expired accepted";
  {
    const orderId = await createOrder(customerToken);
    await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, { method: "POST", token: performerToken, body: {} });
    sql(`UPDATE orders SET deposit_deadline=NOW()-INTERVAL '1 hour' WHERE id='${orderId}';`);
    await enqueue("expired-orders", { orderId });
    await new Promise((r) => setTimeout(r, 4000));
    const st = await api(`/api/v1/orders/${orderId}`, { token: customerToken });
    check("expired -> cancelled", st.json?.data?.order?.status === "cancelled", st.json?.data?.order?.status);
  }

  // S9: arbitration plain resolve
  scenario = "S9 arbitration plain";
  {
    const orderId = await createOrder(customerToken);
    await fullDeposits(customerToken, performerToken, orderId);
    for (const s of ["started", "completed"]) {
      await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: s } });
    }
    await api(`/api/v1/orders/${orderId}/confirm-completion`, { method: "POST", token: customerToken, body: { accepted: false, rating: 2, comment: "bad" } });
    const prop = await api(`/api/v1/orders/${orderId}/arbitration/resolve`, { method: "POST", token: customerToken, body: { decision: "close_plain", rating: 3 }, expect: 201 });
    check("proposal pending", prop.json?.data?.resolution?.status === "pending");
    const ap = await api(`/api/v1/orders/${orderId}/arbitration/resolve/approve`, { method: "POST", token: performerToken });
    check("approved", ap.json?.data?.resolution?.status === "approved");
    const st = await api(`/api/v1/orders/${orderId}`, { token: customerToken });
    check("resolved -> completed", st.json?.data?.order?.status === "completed", st.json?.data?.order?.status);
    check("locks released x2", lockStatus(orderId) === "customer:released\nperformer:released", lockStatus(orderId));
  }

  // S10+S11: arbitration fine + reject/withdraw cycle
  scenario = "S10 arbitration fine";
  let arbOrder;
  {
    arbOrder = await createOrder(customerToken);
    await fullDeposits(customerToken, performerToken, arbOrder);
    for (const s of ["started", "completed"]) {
      await api(`/api/v1/orders/${arbOrder}/status`, { method: "PATCH", token: performerToken, body: { status: s } });
    }
    await api(`/api/v1/orders/${arbOrder}/confirm-completion`, { method: "POST", token: customerToken, body: { accepted: false, rating: 1 } });
    await api(`/api/v1/orders/${arbOrder}/arbitration/resolve`, { method: "POST", token: customerToken, body: { decision: "close_fine" }, expect: 201 });
    const rej = await api(`/api/v1/orders/${arbOrder}/arbitration/resolve/reject`, { method: "POST", token: performerToken });
    check("reject -> rejected", rej.json?.data?.resolution?.status === "rejected");
    const st1 = await api(`/api/v1/orders/${arbOrder}`, { token: customerToken });
    check("stays arbitration", st1.json?.data?.order?.status === "arbitration");
    await api(`/api/v1/orders/${arbOrder}/arbitration/resolve`, { method: "POST", token: customerToken, body: { decision: "close_fine" }, expect: 201 });
    const wd = await api(`/api/v1/orders/${arbOrder}/arbitration/resolve/withdraw`, { method: "POST", token: customerToken });
    check("withdraw -> withdrawn", wd.json?.data?.resolution?.status === "withdrawn");
    await api(`/api/v1/orders/${arbOrder}/arbitration/resolve`, { method: "POST", token: customerToken, body: { decision: "close_fine" }, expect: 201 });
    await api(`/api/v1/orders/${arbOrder}/arbitration/resolve/approve`, { method: "POST", token: performerToken });
    check("fine: performer forfeited", lockStatus(arbOrder).includes("performer:forfeited"), lockStatus(arbOrder));
  }

  // S12: early start
  scenario = "S12 early start";
  {
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const orderId = await createOrder(customerToken, { dateFrom: future, dateTo: new Date(Date.now() + 40 * 864e5).toISOString() });
    await fullDeposits(customerToken, performerToken, orderId);
    const early = await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "started" }, expect: 400 });
    check("started before date w/o approval -> 400", early.ok);
    await api(`/api/v1/orders/${orderId}/early-start`, { method: "POST", token: performerToken, expect: 201 });
    const dup = await api(`/api/v1/orders/${orderId}/early-start`, { method: "POST", token: performerToken, expect: 409 });
    check("double request -> 409", dup.ok);
    await api(`/api/v1/orders/${orderId}/early-start/approve`, { method: "POST", token: customerToken });
    const st = await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "started" } });
    check("started after approval", st.json?.data?.order?.status === "started", st.json?.data?.order?.status);
  }

  // S13: progress
  scenario = "S13 progress";
  {
    const orderId = await createOrder(customerToken);
    await fullDeposits(customerToken, performerToken, orderId);
    await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: performerToken, body: { status: "started" } });
    const form = new FormData();
    form.append("percent", "40");
    form.append("comment", "half done");
    await api(`/api/v1/orders/${orderId}/progress`, { method: "POST", token: performerToken, form, expect: 201 });
    const bad = new FormData();
    const badRes = await api(`/api/v1/orders/${orderId}/progress`, { method: "POST", token: performerToken, form: bad, expect: 400 });
    check("empty progress -> 400", badRes.ok);
    const list = await api(`/api/v1/orders/${orderId}/progress`, { token: customerToken });
    check("timeline has 1 entry", list.json?.data?.progress?.length === 1, JSON.stringify(list.json?.data?.progress)?.slice(0, 120));
  }

  // S15: negatives
  scenario = "S15 negatives";
  {
    const orderId = await createOrder(customerToken);
    const custIntentEarly = await api(`/api/v1/orders/${orderId}/deposits/customer-intent`, { method: "POST", token: customerToken, body: {}, expect: 400 });
    check("customer-intent on published -> 400", custIntentEarly.ok);
    const pIntent = await api(`/api/v1/marketplace/orders/${orderId}/deposits/performer-intent`, { method: "POST", token: performerToken, body: {} });
    const pi = pIntent.json.data.paymentIntent;
    const tampered = await api(`/api/v1/payments/${pi.id}/confirm`, { method: "POST", token: performerToken, body: { providerPayload: { provider: "liqpay", data: "x", signature: "y" } }, expect: 400 });
    check("tampered signature -> 400", tampered.ok);
    const started = await api(`/api/v1/orders/${orderId}/status`, { method: "PATCH", token: customerToken, body: { status: "started" }, expect: 403 });
    check("customer cannot start -> 403", started.ok);
  }

  // S16: matching is idempotent (double run -> single notify per performer)
  scenario = "S16 match idempotency";
  {
    const orderId = await createOrder(customerToken);
    await new Promise((r) => setTimeout(r, 6000));
    const q = new Queue("match-new-order", { connection: conn });
    await q.add("match", { orderId }, { jobId: `order-${orderId}` });
    await new Promise((r) => setTimeout(r, 5000));
    await q.close();
    const rows = sql(`SELECT user_id, count(*) FROM notifications WHERE data->>'orderId'='${orderId}' AND data->>'type'='marketplace.match_added' GROUP BY user_id;`);
    const counts = rows.split("\n").filter(Boolean).map((l) => Number(l.split("|")[1]));
    check("exactly 1 match_added per performer", counts.length > 0 && counts.every((c) => c === 1), rows);
  }

  if (failures > 0) {
    console.error(`MATRIX FAILED with ${failures} failures`);
    process.exit(1);
  }
  console.log("MATRIX PASSED");
}

main().catch((e) => {
  console.error("MATRIX ERROR", e);
  process.exit(1);
});
