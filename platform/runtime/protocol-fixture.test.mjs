import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import {execFileSync} from "node:child_process";
test("synthetic native shell preserves script quotes and literal metacharacters",async()=>{
 const module={exports:{}};
 runInNewContext(await readFile(new URL("./protocol-fixture.mjs",import.meta.url),"utf8"),{module,require:createRequire(import.meta.url),Buffer,console});
 const payload="literal ' quote; $WME_FIXTURE_VALUE; $(printf substituted); newline\nvalue";
 const code="console.log(JSON.stringify("+JSON.stringify(payload)+"))";
 const actual=execFileSync("/bin/sh",["-c",module.exports.shellQuote(process.execPath)+" -e "+module.exports.shellQuote(code)],{encoding:"utf8",env:{...process.env,WME_FIXTURE_VALUE:"must-not-expand"}});
 assert.equal(actual.trim(),JSON.stringify(payload));
});
