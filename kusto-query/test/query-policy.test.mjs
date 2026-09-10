import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQueryAccess } from "../lib/query-policy.mjs";

test("ordinary users can read KQL and discover diagnostic schemas", () => {
  for (const query of ["Log | take 1", "let x = 1; print x", "// case\nexternal_table('OperationLog') | count", "print url='https://example.com'"]) {
    assert.doesNotThrow(() => checkQueryAccess(false, query, "user"));
  }
  for (const command of [".show databases", ".show tables", ".show functions", ".show external tables", ".show materialized-views", ".show table Log schema as json", ".show table Log details", ".show external table OperationLog schema as json", ".show function Requests", ".SHOW table ['Table name'] schema as json"]) {
    assert.doesNotThrow(() => checkQueryAccess(true, command, "user"));
  }
});

test("ordinary-user management writes and batches are rejected", () => {
  for (const command of [".drop table Log", ".set-or-replace Log <| print x=1", ".create table X (a:string)", ".execute database script <| .show tables", ".show tables; .drop table Log", ".show tables\n.drop table Log", ".show queries", ".show table ['x']; .drop table Log", "// bypass\n.show tables", ".show tables | evaluate python()", ".show table Log schema as json\n// comment"]) {
    assert.throws(() => checkQueryAccess(true, command, "user"), /cannot run this management command/);
  }
  for (const command of [".drop table Log", "// comment\n.drop table Log", "/* comment */ .drop table Log", "let x=1; .drop table Log"]) {
    assert.throws(() => checkQueryAccess(false, command, "user"), /Use --mgmt/);
  }
});

test("host and existing privileged workflows keep their access policy", () => {
  for (const role of [undefined, "developer", "oncall"]) {
    assert.doesNotThrow(() => checkQueryAccess(true, ".create table X (a:string)", role));
  }
});
