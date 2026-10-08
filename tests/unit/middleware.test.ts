import test from "node:test";
import assert from "node:assert/strict";

test("idempotency middleware should be importable", async () => {
  const { idempotencyMiddleware } = await import("../../src/lib/middleware/idempotency");
  assert.equal(typeof idempotencyMiddleware, "function");
});

test("retryAfter middleware should be importable", async () => {
  const { retryAfterMiddleware } = await import("../../src/lib/middleware/retryAfter");
  assert.equal(typeof retryAfterMiddleware, "function");
});

test("idempotency middleware should pass through non-state-changing requests", async () => {
  const { idempotencyMiddleware } = await import("../../src/lib/middleware/idempotency");
  const { NextRequest } = await import("next/server");
  const { NextResponse } = await import("next/server");

  let called = false;
  const next = async () => {
    called = true;
    return NextResponse.json({ success: true }, { status: 200 });
  };

  // GET request should bypass idempotency
  const req = new NextRequest(new URL("http://localhost/api/test"), {
    method: "GET",
    headers: { "x-idempotency-key": "test-key" },
  });

  const response = await idempotencyMiddleware(req, next);
  assert.equal(called, true);
  assert.equal(response.status, 200);
});

test("idempotency middleware should pass through requests without idempotency key", async () => {
  const { idempotencyMiddleware } = await import("../../src/lib/middleware/idempotency");
  const { NextRequest, NextResponse } = await import("next/server");

  let called = false;
  const next = async () => {
    called = true;
    return NextResponse.json({ success: true }, { status: 201 });
  };

  const req = new NextRequest(new URL("http://localhost/api/test"), {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  const response = await idempotencyMiddleware(req, next);
  assert.equal(called, true);
  assert.equal(response.status, 201);
});

test("idempotency middleware should handle state-changing methods", async () => {
  const { idempotencyMiddleware } = await import("../../src/lib/middleware/idempotency");
  const { NextRequest, NextResponse } = await import("next/server");

  const methods = ["POST", "PUT", "PATCH", "DELETE"];
  
  for (const method of methods) {
    let called = false;
    const next = async () => {
      called = true;
      return NextResponse.json({ success: true, method }, { status: 200 });
    };

    const req = new NextRequest(new URL("http://localhost/api/test"), {
      method,
      headers: { 
        "content-type": "application/json",
        "x-idempotency-key": `test-key-${method}`,
      },
    });

    const response = await idempotencyMiddleware(req, next);
    assert.equal(called, true, `${method} should call next()`);
    assert.equal(response.status, 200);
  }
});
