const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const apiRoot = path.join(root, "src", "app", "api", "v1");
const mdPath = path.join(root, "endpoints.md");

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function fileToRoute(filePath) {
  const rel = path.relative(apiRoot, filePath).replace(/\\/g, "/");
  const parts = rel.split("/");
  parts.pop();
  const converted = parts.map((p) => {
    if (p.startsWith("[") && p.endsWith("]")) return `:${p.slice(1, -1)}`;
    return p;
  });
  return `/api/v1/${converted.join("/")}`;
}

function methodsOf(ts) {
  const ms = [];
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    if (new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(ts)) ms.push(m);
  }
  return ms;
}

const routeFiles = walk(apiRoot).filter((p) => p.endsWith(`${path.sep}route.ts`));
const implemented = [];
for (const f of routeFiles) {
  const ts = fs.readFileSync(f, "utf8");
  const route = fileToRoute(f);
  for (const m of methodsOf(ts)) implemented.push(`${m} ${route}`);
}

const md = fs.readFileSync(mdPath, "utf8");
const doc = [];
for (const m of md.matchAll(/^###\s+(GET|POST|PUT|PATCH|DELETE)\s+`([^`]+)`/gm)) {
  doc.push(`${m[1]} ${m[2]}`);
}

const implSet = new Set(implemented);
const docSet = new Set(doc);

const missingInDocs = [...implSet].filter((k) => !docSet.has(k)).sort();
const missingInCode = [...docSet].filter((k) => !implSet.has(k)).sort();

process.stdout.write(
  JSON.stringify(
    {
      implemented: implSet.size,
      documented: docSet.size,
      missingInDocs,
      missingInCode,
    },
    null,
    2
  )
);
process.stdout.write("\n");

