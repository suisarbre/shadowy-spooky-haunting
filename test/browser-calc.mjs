// Software TMR calculator panel in headless Chrome
// Serve docs/ on port 8771, then: node test/browser-calc.mjs (needs Playwright; set CHROME to a Chromium path if not bundled)
import { chromium } from "playwright";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 420, height: 2200 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 500 });
const calc = () => p.evaluate(() => { const c = computers[0].calc; return c && { step: c.step, sum: c.sum, ok: calcOk(c), copies: c.copies.join(","), repairs: c.repairs, on: c.on }; });
const panel = () => p.evaluate(() => document.getElementById("calc").innerText.replace(/\s+/g, " "));
const result = (name, ok, detail) => console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);

await p.goto("http://127.0.0.1:8771/");
await until(() => computers[0] && computers[0].calc && computers[0].operational);
let c = await calc(); result("calculator telemetry on the page", c.ok && c.on, JSON.stringify(c));

await p.click("#c-hit2"); await sleep(1600);
const seen = await panel();
await sleep(2000); c = await calc();
result("hit copy 2: repaired, answer still right", c.ok && c.repairs === 1, `${JSON.stringify(c)}`);
result("panel shows the outvoted copy", /outvoted/.test(seen), seen.slice(0, 260));
await p.screenshot({ path: "/home/claude/work/browser9a.png", clip: { x: 0, y: 0, width: 420, height: 1400 } });

await p.click("#c-hit12"); await sleep(3500); c = await calc();
result("hit copies 1+2 same bit: wrong majority, answer wrong", !c.ok, JSON.stringify(c));
await p.click("#c-reset"); await sleep(3000); c = await calc();
result("reset: right again", c.ok, JSON.stringify(c));

await p.click("#c-tmr"); await until(() => computers[0].calc && !computers[0].calc.on, null, 10000);
await p.click("#c-hit1"); await sleep(3500); c = await calc();
result("TMR off: hit copy 1 corrupts the answer", !c.ok && !c.on, JSON.stringify(c));
await sleep(3000); c = await calc();
result("...and it stays wrong", !c.ok, JSON.stringify(c));
await p.click("#c-tmr"); await until(() => computers[0].calc && computers[0].calc.on, null, 10000);
await p.click("#c-reset"); await sleep(3000); c = await calc();
result("TMR on + reset: right again", c.ok && c.on, JSON.stringify(c));

// three-computer mode: calculator runs on each computer
await p.selectOption("#mode", "tmr");
await until(() => computers.length === 3 && computers.every((x) => x.calc && x.operational), null, 150000);
const cards = await p.evaluate(() => computers.map((x) => `${x.name}: step ${x.calc.step} sum ${x.calc.sum} ${calcOk(x.calc) ? "ok" : "WRONG"}`));
result("TMR mode: calculator on all 3 computers", cards.every((x) => /ok$/.test(x)), cards.join(" | "));
await p.selectOption("#target", "1"); await p.click("#c-hit3"); await sleep(3500);
const r = await p.evaluate(() => ({ B: computers[1].calc.repairs, ok: calcOk(computers[1].calc), A: computers[0].calc.repairs }));
result("TMR mode: hit lands on target B only", r.B === 1 && r.A === 0 && r.ok, JSON.stringify(r));
console.log("page errors:", errs.length ? errs : "none");
await b.close();
