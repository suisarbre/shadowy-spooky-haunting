// 3D beam end to end in headless Chrome
import { chromium } from "/opt/npm-tools/node_modules/playwright/index.mjs";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 420, height: 1300 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200))); p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 500 });
const result = (name, ok, detail) => console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);

await p.goto("http://127.0.0.1:8771/");
await until(() => computers[0] && computers[0].operational && computers[0].map && computers[0].calc);
const m = await p.evaluate(() => { const c = computers[0]; const cats = {}; for (let i = 0; i < RAM_PAGES; i++) { const r = c.map.pageRun[i]; const k = r < 0 ? "free" : c.map.runs[r].cat; cats[k] = (cats[k] || 0) + 1; } return cats; });
result("memory map reached the page", m.cfs > 100 && m.kernel > 100, JSON.stringify(m));
await sleep(1000);
await p.screenshot({ path: "/home/claude/work/beam-a.png", clip: { x: 0, y: 0, width: 420, height: 700 } });

// 1) SAMPLE_APP counter: learn its virtual address (two FAULT_INJ flips cancel out), translate with the map, fire the beam there
await p.evaluate(() => { const c = computers[0]; c.send(CMD.fiSymbol("SAMPLE_APP", "SAMPLE_APP_Data", 0, 0x80)); c.send(CMD.fiSymbol("SAMPLE_APP", "SAMPLE_APP_Data", 0, 0x80)); });
await until(() => computers[0].events.some((e) => /SYMBOL hit SAMPLE_APP/.test(e.line)), null, 15000);
await until(() => computers[0].v.ctr !== null, null, 15000);
const aim = await p.evaluate(() => {
  const c = computers[0], ev = c.events.find((e) => /SYMBOL hit SAMPLE_APP/.test(e.line)).line, va = parseInt(ev.match(/@([0-9a-f]+)/)[1], 16);
  const run = c.map.runs.find((r) => r.comm === "core-cpu1" && r.va !== undefined && va >= r.va && va < r.va + r.n * 4096);
  const pa = run.pfn * 4096 + (va - run.va);
  const before = c.v.ctr; const hit = beamAtAddress(0, pa);
  return { va: va.toString(16), pa: pa.toString(16), hit, before, label: c.describe(pa).label };
});
await sleep(7500);
const after = await p.evaluate(() => computers[0].v.ctr);
result("beam at SAMPLE_APP's counter changes its telemetry", aim.hit && aim.hit.pa === parseInt(aim.pa, 16) && after === (aim.before ^ aim.hit.mask), `va ${aim.va} -> pa ${aim.pa} (${aim.label}); mask 0x${aim.hit && aim.hit.mask.toString(16)}; counter ${aim.before} -> ${after}`);
result("beam log line", true, await p.textContent("#beamlog"));

// 2) TMR copy 2
const tmr = await p.evaluate(() => { const c = computers[0], r = c.map.runs.find((x) => x.label === "tmr:CALC:2"); const pa = r.pfn * 4096 + 4; const n0 = c.calc.repairs; const h = beamAtAddress(0, pa); return { pa: pa.toString(16), n0, h }; });
await until((n0) => computers[0].calc.repairs > n0, tmr.n0, 8000).catch(() => {});
const tc = await p.evaluate(() => ({ repairs: computers[0].calc.repairs, ok: calcOk(computers[0].calc) }));
result("beam at TMR copy 2: outvoted and repaired", tc.repairs > tmr.n0 && tc.ok, `pa ${tmr.pa}, what: ${tmr.h && tmr.h.what}; ${JSON.stringify(tc)}`);

// 3) free memory
const fr = await p.evaluate(() => { const c = computers[0]; let pg = 8000; while (c.map.pageRun[pg] >= 0) pg++; return beamAtAddress(0, pg * 4096 + 100); });
await sleep(4000);
const alive = await p.evaluate(() => computers[0].healthy(Date.now()) && calcOk(computers[0].calc));
result("beam at free memory: no effect", fr && /free/.test(fr.what) && alive, fr && fr.what);

// 4) flash (kernel region, top-left of the chip) and the CPU
const fl = await p.evaluate(() => { const r = beamAt(0, "flash", 0.1, 0.05); return { r, diff: computers[0].diffBits() }; });
result("beam at flash: storage damaged, latent", fl.r && fl.diff > 0, `${fl.r && fl.r.what}; ${fl.diff} bit(s) differ`);
const cpu = await p.evaluate(() => { beamAt(0, "cpu", 0.5, 0.5); return document.getElementById("beamlog").textContent; });
result("beam at CPU: reported as not modeled", /CPU/.test(cpu), cpu);
await sleep(300);
await p.screenshot({ path: "/home/claude/work/beam-b.png", clip: { x: 0, y: 0, width: 420, height: 760 } });

// 5) three boards in TMR mode; firing at B targets B
await p.click("#st-restore"); // the flash hit above left latent kernel damage
await p.selectOption("#mode", "tmr");
await until(() => computers.length === 3 && computers.every((c) => c.operational && c.map), null, 240000);
const tb = await p.evaluate(() => { const c = computers[1]; let pg = 8000; while (c.map.pageRun[pg] >= 0) pg++; beamAtAddress(1, pg * 4096); return { target: $("target").value, log: document.getElementById("beamlog").textContent }; });
result("TMR mode: 3 boards, beam on B hits B", tb.target === "1" && /^B /.test(tb.log), tb.log);
await sleep(500);
await p.screenshot({ path: "/home/claude/work/beam-c.png", clip: { x: 0, y: 0, width: 420, height: 700 } });
console.log("page errors:", errs.length ? errs : "none");
await b.close();
