import { test } from "node:test";
import assert from "node:assert/strict";
import { main, run } from "./read.mjs";
const load = async () => ({ genevaMetrics: { readMonitorConfigs: async o => o, readMetricSeries: async o => o } });
const args = ["series", "--namespace", "Lionrock", "--metric", "Event", "--dimensions", "EventId,Level", "--start", "2026-09-15T17:20:00Z", "--end", "2026-09-15T17:40:00Z"];
test("monitor and series modes call Iris with explicit source and certificate paths", async () => {
  assert.equal((await main(["monitors"], load)).account, "agboa");
  const r = await main([...args, "--filters", '{"EventId":["500532"]}', "--sampling", "Count,Sum", "--cert", "/certs/geneva-log.crt", "--key", "/certs/geneva-log.key"], load);
  assert.deepEqual(r.filters.EventId, ["500532"]); assert.deepEqual(r.dimensions, ["EventId", "Level"]); assert.deepEqual(r.samplingTypes, ["Count", "Sum"]); assert.equal(r.certPath, "/certs/geneva-log.crt");
  assert.deepEqual((await main(args, load)).filters, {});
});
test("invalid commands fail before querying", async () => {
  for (const a of [[], ["write"], ["series"], ["monitors", "--unknown"]]) await assert.rejects(main(a, () => assert.fail("loaded Iris")));
});
test("transport failures and partial data return nonzero with evidence preserved", async () => {
  for (const result of [{ status: "empty" }, { status: "incomplete" }, { v1: { status: "ok" }, v2: { status: "unavailable" } }]) {
    const code = await run(["monitors"], async () => ({ genevaMetrics: { readMonitorConfigs: async () => result } }), { log: s => assert.deepEqual(JSON.parse(s), result), error: assert.fail });
    assert.equal(code, result.status === "empty" ? 0 : 1);
  }
  let error; assert.equal(await run([], load, { log: assert.fail, error: s => { error = s; } }), 2); assert.match(error, /Choose/);
});


// The container exposes its Git checkout through a symlink at CLAUDE_CONFIG_DIR/skills.
test("running through a symlink executes the CLI and emits a result", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "geneva-cli-link-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "dist/index.js"), 'export const lionrock = {}; export const genevaLogs = {getExecutionLogs: async () => ({audit:{status:"ok"},tracing:{status:"ok"}})}; export const genevaMetrics = {readMonitorConfigs: async () => ({v1:{status:"ok"},v2:{status:"ok"}})};');
    symlinkSync(fileURLToPath(new URL("../", import.meta.url)), join(dir, "linked-skill"), "dir");
    const entry = join(dir, "linked-skill/bin/read.mjs");
    const commandArgs = ["monitors"];
    const result = spawnSync(process.execPath, [entry, ...commandArgs], {env:{...process.env,IRIS_ROOT:dir},encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), "The CLI silently skipped its entrypoint");
    const output = JSON.parse(result.stdout);
    assert.equal(output.v1.status, "ok");
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
