// One-time migration: copies all existing root-level data into /stores/wiregrass/.
// Non-destructive — root nodes are left in place; delete them manually once the
// new app is verified. Also sets /stores/wiregrass/settings/adminPin from
// VITE_ADMIN_PIN so the PIN keeps working after the env-var auth is removed.
//
// BEFORE RUNNING: paste database.rules.migration.json into the Firebase console
// rules editor. It keeps the old root nodes live for the currently-deployed app,
// unblocks /deleted_competitions (missing from today's rules), and opens /stores
// for this script. After cutover, replace with database.rules.json.
//
// Usage:  node scripts/migrate-to-stores.mjs          (dry run: backup + report only)
//         node scripts/migrate-to-stores.mjs --write  (actually writes to Firebase)

import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter(l => l.includes("="))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const DB_URL = env.VITE_FIREBASE_DATABASE_URL?.replace(/\/$/, "");
const PIN = env.VITE_ADMIN_PIN;
if (!DB_URL || !PIN) throw new Error("Missing VITE_FIREBASE_DATABASE_URL or VITE_ADMIN_PIN in .env");

const WRITE = process.argv.includes("--write");

// Rules are per-node, so read each known root node individually (root .json is denied).
const NODES = ["competitions", "deleted_competitions", "employees", "logs", "settings", "goals"];

async function getJson(path) {
  const res = await fetch(`${DB_URL}/${path}.json`);
  const data = await res.json();
  if (data?.error) throw new Error(`Read of /${path} failed: ${data.error} (update the database rules first — see header comment)`);
  return data;
}

const nodes = {};
for (const name of NODES) {
  const data = await getJson(name);
  if (data !== null) nodes[name] = data;
  console.log(`  /${name}: ${data === null ? "(empty, skipped)" : `${Object.keys(data).length} keys`}`);
}

// Full backup before anything else.
const backupFile = new URL(`../scripts/backup-${Date.now()}.json`, import.meta.url);
writeFileSync(backupFile, JSON.stringify(nodes, null, 2));
console.log(`Backup written: ${backupFile.pathname}`);

nodes.settings = { ...(nodes.settings || {}), adminPin: PIN };

if (!WRITE) {
  console.log("Dry run only. Re-run with --write to migrate.");
  process.exit(0);
}

const existing = await getJson("stores/wiregrass");
if (existing) throw new Error("/stores/wiregrass already exists — aborting to avoid overwrite");

const res = await fetch(`${DB_URL}/stores/wiregrass.json`, {
  method: "PUT",
  body: JSON.stringify(nodes),
});
if (!res.ok) throw new Error(`Write failed: ${res.status} ${await res.text()}`);

// Verify round-trip (key-order-insensitive — Firebase returns keys sorted).
const norm = (o) => o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map(k => [k, norm(o[k])])) : o;
const check = await getJson("stores/wiregrass");
for (const key of Object.keys(nodes)) {
  if (JSON.stringify(norm(nodes[key])) !== JSON.stringify(norm(check?.[key]))) {
    throw new Error(`Verification mismatch on node "${key}"`);
  }
}
console.log("Migration complete and verified. Root nodes left untouched — remove them after the new app is confirmed working.");
