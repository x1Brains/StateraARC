// Deploy gate (09-30): the API crashed on start 5 times on a TypeScript file tsc never saw (tsconfig covered only src/).
// Runs on the VPS before every restart (server/deploy-api.sh) — Node 22 strips the types exactly as the service does,
// then the JS is parsed as a module. Any error = no restart; the running version stays up.
// Syntax-check TypeScript the way the server runs it: strip the types (Node 22), then parse the JS as a module.
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
let bad = 0;
for (const f of process.argv.slice(2)) {
  try { const js = stripTypeScriptTypes(readFileSync(f, "utf8")); writeFileSync("/tmp/_tscheck.mjs", js); execFileSync(process.execPath, ["--check", "/tmp/_tscheck.mjs"], { stdio: "pipe" }); }
  catch (e) { bad++; console.error("SYNTAX ERROR in " + f + ": " + String(e.stderr || e.message).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
}
rmSync("/tmp/_tscheck.mjs", { force: true });
process.exit(bad ? 1 : 0);
