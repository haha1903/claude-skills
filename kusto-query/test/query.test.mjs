import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kusto-cli-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, "dist"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({type:"module"}));
fs.writeFileSync(path.join(root, "dist/index.js"), `
export const lionrock = {};
export const kusto = {
  queryKusto: async (...args) => ({cols:[], rows:[{path:"query", args}]}),
  mgmtKusto: async (...args) => ({cols:[], rows:[{path:"mgmt", args}]})
};
`);
const cli = fileURLToPath(new URL("../bin/query.mjs", import.meta.url));
function run(args, role = "user", iris = root) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: {...process.env, LOOP_ROLE:role, IRIS_ROOT:iris}, encoding:"utf8",
  });
}

test("the CLI routes user queries and permitted schema reads through iris", () => {
  for (const [args, expected] of [
    [["https://cluster", "db", "Log | count"], "query"],
    [["--mgmt", "https://cluster", "db", ".show tables"], "mgmt"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const row = JSON.parse(result.stdout).rows[0];
    assert.equal(row.path, expected);
    assert.deepEqual(row.args, args.slice(expected === "mgmt" ? 1 : 0));
  }
});

test("denied management commands fail before loading iris or authenticating", () => {
  const result = run(["--mgmt", "https://cluster", "db", ".drop table Log"], "user", "/not-an-sdk");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot run this management command/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("the CLI preserves host management behavior and validates arguments", () => {
  assert.equal(run(["--mgmt", "https://cluster", "db", ".create table X (a:string)"], "").status, 0);
  const missing = run([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage:/);
});
