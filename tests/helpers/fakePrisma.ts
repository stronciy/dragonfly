// In-memory stand-in for the Prisma client, installed onto the real `prisma`
// singleton so route handlers and services run unmodified in unit tests.
// Supports the subset of the query API the order/payment/arbitration code uses:
// where filters (equality, in, not, lt/gt, OR/AND), unique compound keys
// (uniq_*), select/include with relations, create/update/upsert/delete and
// $transaction. Unsupported calls throw loudly so gaps surface in tests.
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";

type Row = Record<string, any>;

type Relation = { table: string; fk: string; side: "belongsTo" | "hasMany" | "hasOne"; localKey?: string };

const RELATIONS: Record<string, Record<string, Relation>> = {
  serviceCategory: {
    subcategories: { table: "serviceSubcategory", fk: "categoryId", side: "hasMany" },
  },
  serviceSubcategory: {
    types: { table: "serviceType", fk: "subcategoryId", side: "hasMany" },
  },
  user: {
    customerProfile: { table: "customerProfile", fk: "userId", side: "hasOne" },
    performerProfile: { table: "performerProfile", fk: "userId", side: "hasOne" },
    legalProfile: { table: "legalProfile", fk: "userId", side: "hasOne" },
  },
  order: {
    paymentIntents: { table: "paymentIntent", fk: "orderId", side: "hasMany" },
    escrowLocks: { table: "escrowLock", fk: "orderId", side: "hasMany" },
    progressUpdates: { table: "workProgressUpdate", fk: "orderId", side: "hasMany" },
    customer: { table: "user", fk: "id", side: "belongsTo", localKey: "customerUserId" },
    performer: { table: "user", fk: "id", side: "belongsTo", localKey: "performerUserId" },
  },
  arbitrationCase: {
    order: { table: "order", fk: "id", side: "belongsTo", localKey: "orderId" },
    messages: { table: "arbitrationMessage", fk: "arbitrationCaseId", side: "hasMany" },
    ruling: { table: "arbitrationRuling", fk: "arbitrationCaseId", side: "hasOne" },
    assigneeAdmin: { table: "admin", fk: "id", side: "belongsTo", localKey: "assigneeAdminId" },
  },
  arbitrationMessage: {
    arbitrationCase: { table: "arbitrationCase", fk: "id", side: "belongsTo", localKey: "arbitrationCaseId" },
    user: { table: "user", fk: "id", side: "belongsTo", localKey: "userId" },
    admin: { table: "admin", fk: "id", side: "belongsTo", localKey: "adminId" },
    media: { table: "orderMedia", fk: "arbitrationMessageId", side: "hasMany" },
  },
  orderMedia: {},
  paymentIntent: {
    order: { table: "order", fk: "id", side: "belongsTo", localKey: "orderId" },
  },
  wallet: {
    transactions: { table: "transaction", fk: "walletId", side: "hasMany" },
  },
  transaction: {
    order: { table: "order", fk: "id", side: "belongsTo", localKey: "orderId" },
  },
  orderMatch: {
    order: { table: "order", fk: "id", side: "belongsTo", localKey: "orderId" },
  },
  workProgressUpdate: {
    media: { table: "orderMedia", fk: "progressId", side: "hasMany" },
  },
  payout: {
    user: { table: "user", fk: "id", side: "belongsTo", localKey: "userId" },
  },
};

const FILTER_KEYS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "equals", "contains", "startsWith", "endsWith", "OR", "AND"]);

function isDecimal(v: unknown): v is Prisma.Decimal {
  return v instanceof Prisma.Decimal;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !isDecimal(v);
}

function isFilter(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).some((k) => FILTER_KEYS.has(k));
}

function numeric(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (isDecimal(v)) return v.toNumber();
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== null && nb !== null && (isDecimal(a) || isDecimal(b) || a instanceof Date || b instanceof Date)) {
    return na === nb;
  }
  return a === b;
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (!isFilter(cond)) return valuesEqual(actual, cond);
  const c = cond as Record<string, any>;
  if ("equals" in c && !valuesEqual(actual, c.equals)) return false;
  if ("in" in c && !c.in.some((v: unknown) => valuesEqual(actual, v))) return false;
  if ("notIn" in c && c.notIn.some((v: unknown) => valuesEqual(actual, v))) return false;
  if ("not" in c) {
    if (c.not === null) {
      if (actual === null || actual === undefined) return false;
    } else if (isFilter(c.not)) {
      if (matchValue(actual, c.not)) return false;
    } else if (valuesEqual(actual, c.not)) {
      return false;
    }
  }
  const an = numeric(actual);
  for (const op of ["lt", "lte", "gt", "gte"] as const) {
    if (!(op in c)) continue;
    const bn = numeric(c[op]);
    if (an === null || bn === null) return false;
    if (op === "lt" && !(an < bn)) return false;
    if (op === "lte" && !(an <= bn)) return false;
    if (op === "gt" && !(an > bn)) return false;
    if (op === "gte" && !(an >= bn)) return false;
  }
  if ("contains" in c && !(typeof actual === "string" && actual.includes(c.contains))) return false;
  if ("startsWith" in c && !(typeof actual === "string" && actual.startsWith(c.startsWith))) return false;
  if ("endsWith" in c && !(typeof actual === "string" && actual.endsWith(c.endsWith))) return false;
  return true;
}

// Prisma compound unique keys (`uniq_order_role_lock: {orderId, role}`) are
// flattened into plain column filters.
function flattenWhere(where: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!where) return where;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(where)) {
    if (k.startsWith("uniq_") && isPlainObject(v)) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

function applyData(current: Row | null, data: Record<string, any>): Row {
  const next: Row = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(data)) {
    if (isPlainObject(v) && !isDecimal(v) && !(v instanceof Date) && ("increment" in v || "decrement" in v || "set" in v)) {
      if ("set" in v) next[k] = v.set;
      if ("increment" in v) next[k] = Number(next[k] ?? 0) + Number(v.increment);
      if ("decrement" in v) next[k] = Number(next[k] ?? 0) - Number(v.decrement);
    } else {
      next[k] = v;
    }
  }
  return next;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  private seq = 0;

  reset() {
    this.tables = {};
    this.seq = 0;
  }

  rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = [];
    return this.tables[table];
  }

  /** Insert a row directly (test fixtures). */
  insert(table: string, data: Row): Row {
    return this.create(table, { data });
  }

  matchRow(table: string, row: Row, where: Record<string, any> | undefined): boolean {
    if (!where) return true;
    for (const key of Object.keys(where)) {
      const cond = where[key];
      if (key === "OR") {
        if (!(cond as Record<string, any>[]).some((w) => this.matchRow(table, row, w))) return false;
        continue;
      }
      if (key === "AND") {
        if (!(cond as Record<string, any>[]).every((w) => this.matchRow(table, row, w))) return false;
        continue;
      }
      const rel = RELATIONS[table]?.[key];
      if (rel && rel.side === "hasMany" && isPlainObject(cond) && ("some" in cond || "none" in cond || "every" in cond)) {
        const related = this.rows(rel.table).filter((t) => t[rel.fk] === row.id);
        if ("some" in cond && !related.some((t) => this.matchRow(rel.table, t, cond.some))) return false;
        if ("none" in cond && related.some((t) => this.matchRow(rel.table, t, cond.none))) return false;
        if ("every" in cond && !related.every((t) => this.matchRow(rel.table, t, cond.every))) return false;
        continue;
      }
      if (rel && rel.side === "belongsTo" && isPlainObject(cond) && !isFilter(cond)) {
        const localValue = row[rel.localKey ?? rel.fk];
        const target = this.rows(rel.table).find((t) => t[rel.fk] === localValue);
        if (!target || !this.matchRow(rel.table, target, cond)) return false;
        continue;
      }
      if (!matchValue(row[key], cond)) return false;
    }
    return true;
  }

  private nextId(table: string) {
    this.seq += 1;
    return `${table}_${this.seq}`;
  }

  private project(table: string, row: Row, args?: { select?: Record<string, any>; include?: Record<string, any> }): Row {
    const out: Row = { ...row };
    const rels = RELATIONS[table] ?? {};
    if (args?.select) {
      const picked: Row = {};
      for (const [key, sel] of Object.entries(args.select)) {
        if (!sel) continue;
        if (rels[key]) picked[key] = this.resolveRelation(table, row, key, sel === true ? {} : sel);
        else picked[key] = row[key];
      }
      return picked;
    }
    if (args?.include) {
      for (const [key, sel] of Object.entries(args.include)) {
        if (!sel) continue;
        if (rels[key]) out[key] = this.resolveRelation(table, row, key, sel === true ? {} : sel);
      }
    }
    return out;
  }

  private resolveRelation(table: string, row: Row, key: string, sel: Record<string, any>): any {
    const rel = RELATIONS[table][key];
    const targetRows = this.rows(rel.table);
    if (rel.side === "belongsTo") {
      const localValue = row[rel.localKey ?? rel.fk];
      const target = targetRows.find((r) => r[rel.fk] === localValue) ?? null;
      return target ? this.project(rel.table, target, sel as any) : null;
    }
    const related = targetRows.filter((r) => this.matchRow(rel.table, r, sel.where) && r[rel.fk] === row.id);
    if (rel.side === "hasOne") {
      const t = related[0] ?? null;
      return t ? this.project(rel.table, t, sel as any) : null;
    }
    return related.map((r) => this.project(rel.table, r, sel as any));
  }

  private sortRows(rows: Row[], orderBy: any) {
    if (!orderBy) return rows;
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of list) {
        const [field, dir] = Object.entries(spec)[0] as [string, string];
        const av = numeric(a[field]) ?? 0;
        const bv = numeric(b[field]) ?? 0;
        if (av !== bv) return dir === "desc" ? bv - av : av - bv;
      }
      return 0;
    });
  }

  findMany(table: string, args: any = {}): Row[] {
    let rows = this.rows(table).filter((r) => this.matchRow(table, r, flattenWhere(args.where)));
    rows = this.sortRows(rows, args.orderBy);
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => this.project(table, r, args));
  }

  findFirst(table: string, args: any = {}): Row | null {
    return this.findMany(table, { ...args, take: 1 })[0] ?? null;
  }

  findUnique(table: string, args: any = {}): Row | null {
    return this.findFirst(table, args);
  }

  create(table: string, args: any): Row {
    const now = new Date();
    const nested: Array<[string, Relation, any]> = [];
    const plain: Row = {};
    for (const [k, v] of Object.entries(args.data ?? {})) {
      const rel = RELATIONS[table]?.[k];
      if (rel && isPlainObject(v) && "create" in v) nested.push([k, rel, v.create]);
      else plain[k] = v;
    }
    const row: Row = {
      id: this.nextId(table),
      createdAt: now,
      updatedAt: now,
      ...applyData(null, plain),
    };
    for (const [, rel, data] of nested) {
      this.create(rel.table, { data: { ...data, [rel.fk]: row.id } });
    }
    if (!row.id || typeof row.id !== "string") row.id = this.nextId(table);
    this.rows(table).push(row);
    return this.project(table, row, args);
  }

  update(table: string, args: any): Row {
    const row = this.rows(table).find((r) => this.matchRow(table, r, flattenWhere(args.where)));
    if (!row) throw new Error(`fake: Record to update not found in ${table}`);
    Object.assign(row, applyData(row, args.data), { updatedAt: new Date() });
    return this.project(table, row, args);
  }

  updateMany(table: string, args: any): { count: number } {
    const rows = this.rows(table).filter((r) => this.matchRow(table, r, flattenWhere(args.where)));
    for (const row of rows) Object.assign(row, applyData(row, args.data), { updatedAt: new Date() });
    return { count: rows.length };
  }

  upsert(table: string, args: any): Row {
    const existing = this.rows(table).find((r) => this.matchRow(table, r, flattenWhere(args.where)));
    if (existing) return this.update(table, { where: args.where, data: args.update, select: args.select, include: args.include });
    return this.create(table, { data: args.create, select: args.select, include: args.include });
  }

  delete(table: string, args: any): Row {
    const list = this.rows(table);
    const idx = list.findIndex((r) => this.matchRow(table, r, flattenWhere(args.where)));
    if (idx < 0) throw new Error(`fake: Record to delete not found in ${table}`);
    const [removed] = list.splice(idx, 1);
    return removed;
  }

  deleteMany(table: string, args: any): { count: number } {
    const list = this.rows(table);
    const keep = list.filter((r) => !this.matchRow(table, r, flattenWhere(args?.where)));
    const count = list.length - keep.length;
    this.tables[table] = keep;
    return { count };
  }

  groupBy(table: string, args: any): Record<string, any>[] {
    const rows = this.rows(table).filter((r) => this.matchRow(table, r, flattenWhere(args.where)));
    const by: string[] = args.by ?? [];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify(by.map((f) => row[f] ?? null));
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()].map((group) => {
      const out: Record<string, any> = {};
      for (const field of by) out[field] = group[0][field];
      if (args._count) out._count = { _all: group.length };
      return out;
    });
  }

  aggregate(table: string, args: any = {}): Record<string, any> {
    const rows = this.rows(table).filter((r) => this.matchRow(table, r, flattenWhere(args.where)));
    const out: Record<string, any> = {};
    for (const op of ["_sum", "_avg", "_min", "_max"] as const) {
      if (!args[op]) continue;
      out[op] = {};
      for (const field of Object.keys(args[op])) {
        const values = rows.map((r) => numeric(r[field])).filter((v): v is number => v !== null);
        const total = values.reduce((acc, v) => acc + v, 0);
        out[op][field] =
          op === "_sum" ? (values.length ? total : null)
          : op === "_avg" ? (values.length ? total / values.length : null)
          : op === "_min" ? (values.length ? Math.min(...values) : null)
          : (values.length ? Math.max(...values) : null);
      }
    }
    if (args._count) out._count = rows.length;
    return out;
  }

  count(table: string, args: any = {}): number {
    return this.rows(table).filter((r) => this.matchRow(table, r, flattenWhere(args.where))).length;
  }
}

export const db = new FakeDb();

const MODELS = [
  "user", "order", "orderStatusEvent", "orderMatch", "paymentIntent", "escrowLock", "paymentRequest",
  "arbitrationCase", "arbitrationMessage", "arbitrationRuling", "arbitrationResolution", "orderMedia",
  "notification", "device", "review", "performerProfile", "customerProfile", "workProgressUpdate",
  "refreshToken", "earlyStartRequest", "admin", "adminAuditLog", "legalProfile", "performerService", "payout",
  "field", "serviceCategory", "serviceSubcategory", "serviceType",
  "passwordResetToken", "adminPasswordResetToken", "wallet", "transaction", "crop", "customerCropStat", "clientDiagnosticReport",
];

const METHODS = [
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "create", "createMany",
  "update", "updateMany", "upsert", "delete", "deleteMany", "aggregate", "groupBy",
] as const;

let installed = false;

/** Route the real prisma singleton's model delegates to the in-memory db. */
export function installFakePrisma() {
  if (installed) return;
  installed = true;
  const anyPrisma = prisma as any;
  for (const model of MODELS) {
    const delegate = anyPrisma[model];
    if (!delegate) continue;
    for (const method of METHODS) {
      delegate[method] = (args?: any) => {
        switch (method) {
          case "findUnique":
          case "findUniqueOrThrow":
            return Promise.resolve(db.findUnique(model, args));
          case "findFirst":
          case "findFirstOrThrow":
            return Promise.resolve(db.findFirst(model, args));
          case "findMany":
            return Promise.resolve(db.findMany(model, args));
          case "count":
            return Promise.resolve(db.count(model, args));
          case "aggregate":
            return Promise.resolve(db.aggregate(model, args));
          case "groupBy":
            return Promise.resolve(db.groupBy(model, args));
          case "create":
            return Promise.resolve(db.create(model, args));
          case "createMany":
            for (const data of Array.isArray(args.data) ? args.data : [args.data]) db.create(model, { data });
            return Promise.resolve({ count: Array.isArray(args.data) ? args.data.length : 1 });
          case "update":
            return Promise.resolve(db.update(model, args));
          case "updateMany":
            return Promise.resolve(db.updateMany(model, args));
          case "upsert":
            return Promise.resolve(db.upsert(model, args));
          case "delete":
            return Promise.resolve(db.delete(model, args));
          case "deleteMany":
            return Promise.resolve(db.deleteMany(model, args));
        }
      };
    }
  }
  anyPrisma.$executeRaw = async () => 0;
  anyPrisma.$transaction = async (input: any) => {
    if (typeof input === "function") return input(anyPrisma);
    const out = [];
    for (const p of input) out.push(await p);
    return out;
  };
}
