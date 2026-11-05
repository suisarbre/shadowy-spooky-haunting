// End-to-end test of the page in headless Chrome. Serve docs/ on PORT first:
//   (cd docs && python3 -m http.server 8773) & node test/browser-lab.mjs
import { chromium } from "playwright";
const PORT = process.env.PORT || 8773, CHROME = process.env.CHROME;
const b = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 300)));
const t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
let pass = 0, fail = 0;
const result = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 300 }).then(() => true, () => false);
const up = () => until(() => window.sim && sim.fc.operational && sim.fc.map && sim.fc.app.calc && sim.fc.findRun("tmr:CALC:3"), null, 150000);
const ev = (fn, arg) => p.evaluate(fn, arg);

await p.goto(`http://127.0.0.1:${PORT}/`);
result("boots to OPERATIONAL with a memory map and calculator telemetry", await up(), await ev(() => sim.fc.state));
await ev(() => { localStorage.clear(); sim.missions.select("break"); });

// ---- semantic zoom ----
await ev(() => sim.zoomToCopy(2)); await sleep(2200);
let z = await ev(() => ({ level: sim.board.level, where: sim.board.center() }));
result("fly to TMR copy 2: zoomed to readable bits", z.level === "text" && /tmr:CALC:2/.test(z.where), `${z.level} · ${z.where}`);
await p.screenshot({ path: "test-zoom.png" });
// a real click at the centre of the view flips exactly the bit under it
const box = await p.locator("#view3d canvas").boundingBox();
const aim = await ev(([x, y]) => { const q = sim.board.pickAt(x, y); return { addr: q.addr, bit: q.bit, before: sim.fc.readRam(q.addr, 1)[0] }; }, [box.x + box.width / 2, box.y + box.height / 2]);
await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(100);
const after = await ev((a) => sim.fc.readRam(a, 1)[0], aim.addr);
result("click on a bit flips exactly that bit", (aim.before ^ after) === 1 << aim.bit, `0x${aim.addr.toString(16)} bit ${aim.bit}: ${aim.before} -> ${after}`);

// ---- software TMR ----
const tmr = await ev(() => { const r = sim.fc.findRun("tmr:CALC:2"); return { pa: r.pfn * 4096 + 4, n0: sim.fc.app.calc.repairs }; });
await ev((pa) => sim.board.strikeAt("ram", pa, 4), tmr.pa);
const repaired = await until((n0) => sim.fc.app.calc.repairs > n0, tmr.n0, 6000);
result("bit flip in TMR copy 2: outvoted and repaired, answer right", repaired && await ev(() => sim.calcOk(sim.fc.app.calc)), JSON.stringify(await ev(() => sim.fc.app.calc)));
await ev(() => sim.applySetup({ tmr: false })); await until(() => !sim.fc.app.calc.on, null, 8000);
await ev(() => { const r = sim.fc.findRun("tmr:CALC:1"); sim.board.strikeAt("ram", r.pfn * 4096 + 4, 4); });
result("TMR off: the same hit on copy 1 makes the answer wrong", await until(() => !sim.calcOk(sim.fc.app.calc), null, 6000), JSON.stringify(await ev(() => sim.fc.app.calc)));
await ev(() => { sim.applySetup({ tmr: true }); sim.fc.send(sim.commands.calcReset()); });

// ---- ECC ----
await ev(() => sim.applySetup({ ecc: true }));
// a free page well away from everything
const free = await ev(() => { let pg = 9000; while (sim.fc.map.pageRun[pg] >= 0) pg++; return pg * 4096 + 64; });
let r = await ev((pa) => { const before = sim.fc.readRam(pa, 1)[0]; const h = sim.board.strikeAt("ram", pa, 3); return { o: h.outcome, same: sim.fc.readRam(pa, 1)[0] === before, latent: sim.fc.latentMask(pa) }; }, free);
result("ECC on, 1 bit: corrected, memory reads right, the cell is still flipped", r.o === "corrected" && r.same && r.latent === 8, JSON.stringify(r));
r = await ev((pa) => ({ o: sim.board.strikeAt("ram", pa + 1, 0).outcome, state: sim.fc.state }), free);
result("second bit in the same word, free memory: detected, no reset (nothing reads it)", r.o === "detected-unused" && r.state === "operational", JSON.stringify(r));
await ev(() => sim.fc.scrub());
r = await ev((pa) => ({ latent: sim.fc.ecc.latent.size, retired: /retired/.test(sim.fc.events.at(-1).line) }), free);
result("scrubber reports the uncorrectable word in free memory", r.latent === 0 && r.retired, JSON.stringify(r));
// three bits of one byte whose Hamming positions XOR to 0: the decoder sees nothing
r = await ev((pa) => { const before = sim.fc.readRam(pa, 1)[0]; const outs = [0, 1, 2].map((k) => sim.board.strikeAt("ram", pa, k).outcome); return { outs, before, after: sim.fc.readRam(pa, 1)[0] }; }, free + 8);
result("3 bits in one word: silent corruption, no alarm", r.outs[2] === "silent" && (r.before ^ r.after) === 7, JSON.stringify(r));
await ev((pa) => sim.board.strikeAt("ram", pa, 6), free + 16);
r = await ev(() => { const n = sim.fc.ecc.scrubbed; sim.fc.scrub(); return { latent: sim.fc.ecc.latent.size, scrubbed: sim.fc.ecc.scrubbed - n }; });
result("scrubber rewrites a corrected word", r.latent === 0 && r.scrubbed === 1, JSON.stringify(r));
r = await ev((pa) => { sim.board.strikeAt("ram", pa, 2); const before = sim.fc.readRam(pa, 1)[0]; sim.applySetup({ ecc: false }); return { before, after: sim.fc.readRam(pa, 1)[0] }; }, free + 24);
result("ECC switched off: the error it was hiding appears in memory", (r.before ^ r.after) === 4, JSON.stringify(r));
// 2-bit upset in memory the flight software uses: machine check
await ev(() => sim.applySetup({ ecc: true }));
const used = await ev(() => { const r = sim.fc.findRun("tmr:CALC:1"); return r.pfn * 4096 + 200; });
r = await ev((pa) => ({ o: sim.board.strikeAt("ram", pa, 3, "2").outcome }), used);
await sleep(300);
result("2-bit upset in used memory: machine check, the computer resets", r.o === "machine-check" && await ev(() => sim.fc.fram.lastReset === "ECC machine check"), JSON.stringify(r));
result("...and comes back", await up());
await ev(() => sim.applySetup({ ecc: false }));

// ---- watchdog (mission 2 ticks itself off) ----
await ev(() => { sim.missions.select("watchdog"); sim.applySetup({ watchdog: true }); });
await ev(() => sim.fc.sh("kill -9 $(pidof core-cpu1)"));
const wd = await until(() => sim.fc.fram.lastReset === "watchdog", null, 40000);
result("flight software killed: the watchdog resets the computer", wd, await ev(() => sim.fc.fram.lastReset));
result("...and it comes back", await up());
await sleep(500);
r = await ev(() => sim.missions.done().watchdog);
result("mission 2 goals ticked off by themselves", r && r.every(Boolean), JSON.stringify(r));

// ---- particle shower ----
r = await ev(() => { const run = sim.fc.map.runs.find((x) => x.label === "heap") || sim.fc.map.runs.find((x) => x.cat === "fsw"); const h = sim.board.strikeAt("ram", run.pfn * 4096 + 8, 0, "shower"); return h && h.shower; });
result("particle shower flips many bits at once", r && Object.values(r).reduce((a, n) => a + n, 0) >= 30, JSON.stringify(r));
await ev(() => sim.fc.powerCycle("ground command")); await up();

// ---- SD card: latent damage, boot loop, restore (mission 6) ----
await ev(() => sim.missions.select("sd"));
const exe = await ev(() => { const f = sim.fc.images.files.find((x) => x.name === "cfs/cpu1/core-cpu1"); return sim.fc.images.kernel.length + f.dataOff; });
await ev((i) => sim.board.strikeAt("sd", i, 0), exe);
r = await ev(() => ({ state: sim.fc.state, bits: sim.fc.sdDamagedBits() }));
result("SD card hit on the cFS executable: running system unaffected", r.state === "operational" && r.bits === 1, JSON.stringify(r));
await ev(() => sim.fc.powerCycle("ground command"));
result("power cycle: flight software cannot start", await until(() => sim.fc.state === "badimage", null, 40000), await ev(() => sim.fc.state));
result("boot loop: FRAM counts failed boots", await until(() => sim.fc.fram.failedStreak >= 2, null, 150000), JSON.stringify(await ev(() => sim.fc.fram)));
await ev(() => sim.fc.restoreSd());
result("restore SD card: the next reset boots clean", await up(), JSON.stringify(await ev(() => sim.fc.fram)));
await sleep(500);
r = await ev(() => sim.missions.done().sd);
result("mission 6 goals ticked off by themselves", r && r.every(Boolean), JSON.stringify(r));

await ev(() => sim.board.home()); await sleep(1500);
await p.screenshot({ path: "test-board.png" });
result("no page errors", errs.length === 0, errs.join(" | "));
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
