// Memory microscope in headless Chrome
import { chromium } from "/opt/npm-tools/node_modules/playwright/index.mjs";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 420, height: 1600 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 300 });
const result = (name, ok, detail) => console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
const rows = () => p.evaluate(() => [...document.querySelectorAll("#sc-bits .brow")].map((r) => r.querySelector(".addr").textContent + " " + r.querySelector(".val").textContent));

await p.goto("http://127.0.0.1:8771/");
await until(() => computers[0] && computers[0].operational && computers[0].map && computers[0].calc);
await until(() => document.querySelectorAll("#sc-bits .brow").length === 6, null, 20000);
const r1 = await rows(); await sleep(2200); const r2 = await rows();
result("TMR view: 6 rows (step + sum for 3 copies), values advance live", r1.length === 6 && r1[1] !== r2[1], `${r1[1]} -> ${r2[1]}`);
const flashed = await p.evaluate(() => new Promise((res) => { const iv = setInterval(() => { if (document.querySelector("#sc-bits .bit.chg")) { clearInterval(iv); res(true); } }, 50); setTimeout(() => { clearInterval(iv); res(false); }, 3000); }));
result("changing bits flash", flashed);

// click bit 4 of the low byte of copy 2's sum (row 4, first byte; bits shown 7..0 so index 3)
const before = await p.evaluate(() => computers[0].calc.repairs);
const clicked = await p.evaluate(() => { const row = document.querySelectorAll("#sc-bits .brow")[3]; const bit = row.querySelectorAll(".bit")[3]; const pa = +bit.dataset.a, bb = +bit.dataset.b; bit.click(); return { pa: pa.toString(16), bit: bb, val: row.querySelector(".val").textContent }; });
await sleep(150);
const afterClick = await rows();
await until((n) => computers[0].calc.repairs > n, before, 5000).catch(() => {});
await sleep(800);
const healed = await rows();
const rep = await p.evaluate(() => ({ repairs: computers[0].calc.repairs, ok: calcOk(computers[0].calc) }));
result("click one bit in copy 2: it flips, then the vote repairs it", rep.repairs > before && rep.ok && healed[3].split("= ")[1] === healed[1].split("= ")[1] && healed[3].split("= ")[1] === healed[5].split("= ")[1], `clicked pa ${clicked.pa} bit ${clicked.bit}; right after: ${afterClick[3]}; after vote: ${healed.filter((x, i) => i % 2).join(" | ")}`);
const hitMark = await p.evaluate(() => document.querySelectorAll("#sc-bits .bit.hit").length);
result("flipped bit is highlighted", hitMark >= 1, `${hitMark} highlighted`);
await p.screenshot({ path: "/home/claude/work/scope-tmr.png", clip: { x: 0, y: 760, width: 420, height: 420 } });

// a 3D hit opens the microscope at that byte
const ram = await p.evaluate(() => { const c = computers[0]; const run = c.map.runs.find((r) => r.label === "sample_app.so:data"); const pa = run.pfn * 4096 + 0x40; beamAtAddress(0, pa); return { pa: pa.toString(16), head: document.getElementById("sc-head").textContent, last: !document.getElementById("sc-last").disabled }; });
await sleep(400);
const hl = await p.evaluate(() => document.querySelectorAll("#sc-bits .bit.hit").length);
result("3D hit opens the microscope at that byte, hit highlighted", /sample_app.so:data/.test(ram.head) && ram.last && hl >= 1, `${ram.head}`);
await p.click("#sc-next"); await sleep(400);
const nh = await p.textContent("#sc-head");
result("next 64 bytes", nh !== ram.head, nh.slice(0, 120));
await p.screenshot({ path: "/home/claude/work/scope-win.png", clip: { x: 0, y: 760, width: 420, height: 520 } });
console.log("page errors:", errs.length ? errs : "none");
await b.close();
