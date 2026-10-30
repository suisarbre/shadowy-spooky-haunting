// Single and TMR modes of the demo page in headless Chrome
// Serve docs/ on port 8771, then: node test/browser-modes.mjs (needs Playwright; set CHROME to a Chromium path if not bundled)
import { chromium } from "playwright";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 420, height: 1600 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const st = () => p.evaluate(() => document.getElementById("status").textContent.trim());
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 500 });
const comp = (i) => p.evaluate((i) => { const c = computers[i]; return { status: c.statusHtml.replace(/<[^>]+>/g, ""), ctr: c.v.ctr, boots: c.boots, resets: c.wdResets, resyncs: c.resyncs, healthy: c.healthy(Date.now()) }; }, i);
const pick = async (i) => { await p.selectOption("#target", String(i)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (name, ok, detail) => console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);

await p.goto("http://127.0.0.1:8771/");

// ---------------- single ----------------
await until(() => /OPERATIONAL/.test(document.getElementById("status").textContent));
result("single: boots to OPERATIONAL", true, await st());
await sleep(3000);
await p.click("#f-code");
await until(() => computers[0].wdResets === 1, null, 60000).catch(() => {});
let a = await comp(0); result("single: code hits -> watchdog reset", a.resets === 1, JSON.stringify(a));
await until(() => computers[0].operational, null, 90000).catch(() => {});
a = await comp(0); result("single: back on its own", a.status.startsWith("OPERATIONAL"), JSON.stringify(a));

// ---------------- TMR ----------------
await p.selectOption("#mode", "tmr");
const tB = Date.now();
await until(() => computers.length === 3 && computers.every((c) => c.operational), null, 150000);
result("tmr: 3 computers OPERATIONAL", true, `${((Date.now() - tB) / 1000).toFixed(0)}s after power-on`);
await until(() => /3\/3 agree/.test(document.getElementById("status").textContent), null, 30000).catch(() => {});
result("tmr: voter sees 3/3 agree", /3\/3/.test(await st()), await st());

// 1) counter hit on B -> B outvoted, ground value unchanged, B resynced
await pick(1);
const voted0 = await p.evaluate(() => voter.voted);
await p.click("#f-counter");
await until(() => computers[1].v.ctr !== null && computers[1].v.ctr !== voter.voted, null, 20000).catch(() => {});
const midStatus = await st(); const midVoted = await p.evaluate(() => voter.voted); const bCtr = (await comp(1)).ctr;
result("tmr: B's counter corrupted but ground value unchanged", midVoted === voted0 && bCtr !== voted0, `B=${bCtr}, voted=${midVoted}; status: ${midStatus}`);
await until(() => computers[1].resyncs >= 1, null, 40000).catch(() => {});
await sleep(7000);
let B = await comp(1);
result("tmr: B outvoted and resynced", B.resyncs >= 1 && B.ctr === voted0, JSON.stringify(B));

// 2) kill C's flight software -> resync before the watchdog reboots it
await pick(2);
const tK = Date.now();
await p.click("#b-kill");
await until(() => computers[2].resyncs >= 1, null, 40000).catch(() => {});
let C = await comp(2);
result("tmr: C crash -> resynced, no reboot", C.resyncs >= 1 && C.resets === 0 && C.boots === 1, `${((Date.now() - tK) / 1000).toFixed(1)}s after kill; ${JSON.stringify(C)}`);
await sleep(8000);
C = await comp(2);
result("tmr: C keeps running after resync", C.healthy && C.resets === 0, JSON.stringify(C));
result("tmr: voted output stayed available", /agree/.test(await st()), await st());

// 3) a ground command still reaches all three after resyncs
const before = await p.evaluate(() => computers.map((c) => c.v.ctr));
await p.click("#b-sample-noop");
await until(() => computers.every((c, i) => c.v.ctr !== null && c.v.ctr !== window.__b?.[i]), null, 1).catch(() => {});
await sleep(8000);
const after = await p.evaluate(() => computers.map((c) => c.v.ctr));
result("tmr: ground command fanned out to all 3", after.every((v, i) => v === before[i] + 1), `before ${before} after ${after}`);
console.log("\nvoter:", await p.textContent("#voter"));
console.log("events:\n" + (await p.textContent("#evt")).split("\n").filter((l) => /VOTER|GROUND/.test(l)).slice(-6).join("\n"));
console.log("page errors:", errs.length ? errs : "none");
await b.close();
