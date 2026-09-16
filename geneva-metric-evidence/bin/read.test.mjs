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
