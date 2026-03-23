"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
(0, node_test_1.default)("idempotency middleware should be importable", async () => {
    const { idempotencyMiddleware } = await Promise.resolve().then(() => __importStar(require("../../src/lib/middleware/idempotency")));
    strict_1.default.equal(typeof idempotencyMiddleware, "function");
});
(0, node_test_1.default)("retryAfter middleware should be importable", async () => {
    const { retryAfterMiddleware } = await Promise.resolve().then(() => __importStar(require("../../src/lib/middleware/retryAfter")));
    strict_1.default.equal(typeof retryAfterMiddleware, "function");
});
(0, node_test_1.default)("idempotency middleware should pass through non-state-changing requests", async () => {
    const { idempotencyMiddleware } = await Promise.resolve().then(() => __importStar(require("../../src/lib/middleware/idempotency")));
    const { NextRequest } = await Promise.resolve().then(() => __importStar(require("next/server")));
    const { NextResponse } = await Promise.resolve().then(() => __importStar(require("next/server")));
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
    strict_1.default.equal(called, true);
    strict_1.default.equal(response.status, 200);
});
(0, node_test_1.default)("idempotency middleware should pass through requests without idempotency key", async () => {
    const { idempotencyMiddleware } = await Promise.resolve().then(() => __importStar(require("../../src/lib/middleware/idempotency")));
    const { NextRequest, NextResponse } = await Promise.resolve().then(() => __importStar(require("next/server")));
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
    strict_1.default.equal(called, true);
    strict_1.default.equal(response.status, 201);
});
(0, node_test_1.default)("idempotency middleware should handle state-changing methods", async () => {
    const { idempotencyMiddleware } = await Promise.resolve().then(() => __importStar(require("../../src/lib/middleware/idempotency")));
    const { NextRequest, NextResponse } = await Promise.resolve().then(() => __importStar(require("next/server")));
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
        strict_1.default.equal(called, true, `${method} should call next()`);
        strict_1.default.equal(response.status, 200);
    }
});
