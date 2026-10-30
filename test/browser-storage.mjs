// Boot storage (SD card) hits and boot loops, in headless Chrome
// Serve docs/ on port 8771, then: node test/browser-storage.mjs (needs Playwright; set CHROME to a Chromium path if not bundled)
import { chromium } from "playwright";
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 420, height: 1400 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 500 });
const result = (name, ok, detail) => console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
const st = () => p.evaluate(() => { const c = computers[0]; return { status: c.statusHtml.replace(/<[^>]+>/g, ""), boots: c.boots, fails: c.failedStreak, resets: c.wdResets, last: c.lastReset, diff: c.diffBits(), op: c.operational }; });
const hit = (file, off, bit) => p.evaluate(([f, o, bt]) => computers[0].hitStorage(f, o, bt), [file, off, bit]);
const cycle = async () => { const n = (await st()).boots; await p.click("#st-cycle"); await until((n) => computers[0].boots > n, n, 15000); };
const conTail = () => p.evaluate(() => computers[0].con.split("FSW-AUTOSTART").pop().replace(/\s+/g, " ").slice(0, 300));

await p.goto("http://127.0.0.1:8771/");
await until(() => computers[0] && computers[0].operational);
result("boot 1", true, JSON.stringify(await st()));

// A: a file nothing uses
await hit("cfs/cpu1/cf/cfe_test_tbl.tbl", 0, 0);
let s = await st(); result("hit an unused file: running system unaffected", s.op && s.diff === 1, JSON.stringify(s));
await cycle(); await until(() => computers[0].operational);
s = await st(); result("...and the next boot is normal", s.op && s.last === "ground command", JSON.stringify(s));

// B: one app's file
await p.click("#st-restore");
await hit("cfs/cpu1/cf/sample_app.so", 0, 0);
await cycle(); await until(() => computers[0].operational); await p.waitForTimeout(3000);
const tB = await conTail();
result("hit sample_app.so: only that app fails to load", /Could not load file:\/cf\/sample_app.so/.test(tB), tB.slice(0, 220));

// C: the cFS executable -> boot loop, recorded in FRAM
await p.click("#st-restore");
await hit("cfs/cpu1/core-cpu1", 0, 0);
await cycle();
await until(() => /could not start/.test(computers[0].statusHtml), null, 40000).catch(() => {});
result("hit core-cpu1: flight software cannot start", /could not start/.test((await st()).status), (await conTail()).slice(0, 160));
await until(() => computers[0].failedStreak >= 2, null, 150000);
s = await st(); result("boot loop: FRAM counts failed boots and the watchdog reset", s.fails >= 2 && s.last === "watchdog", JSON.stringify(s));

// D: ground restores the SD card; the next watchdog reset boots clean
await p.click("#st-restore");
await until(() => computers[0].operational, null, 150000);
s = await st(); result("restore: next reset boots clean, FRAM streak cleared", s.op && s.fails === 0 && s.diff === 0, JSON.stringify(s));
console.log("page errors:", errs.length ? errs : "none");
await b.close();
