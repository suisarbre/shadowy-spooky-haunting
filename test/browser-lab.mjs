// End-to-end test of the page in headless Chrome. Serve docs/ on PORT first:
//   (cd docs && python3 -m http.server 8773) & node test/browser-lab.mjs
import { chromium } from "playwright";
const PORT = process.env.PORT || 8773, CHROME = process.env.CHROME;
const b = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e.stack || e).slice(0, 600)));
const t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
let pass = 0, fail = 0;
const result = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${T()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, arg, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 300 }).then(() => true, () => false);
const up = () => until(() => window.sim && sim.fc.operational && sim.fc.map && sim.fc.app.calc && sim.fc.findRun("tmr:CALC:3"), null, 150000);
const ev = (fn, arg) => p.evaluate(fn, arg);

await p.goto(`http://127.0.0.1:${PORT}/`);
result("boots to OPERATIONAL with a memory map and calculator telemetry", await up(), await ev(() => sim.fc.state));

// ---- semantic zoom ----
await ev(() => sim.zoomToCopy(2)); await sleep(3200);
let z = await ev(() => ({ level: sim.board.level, where: sim.board.center() }));
result("fly to TMR copy 2: zoomed to readable bits", z.level === "text" && /tmr:CALC:2/.test(z.where), `${z.level} · ${z.where}`);
await p.screenshot({ path: "test-zoom.png" });
// a real click at the centre of the view flips exactly the bit under it (single-bit particle)
await ev(() => sim.applySetup({ particle: "bit" }));
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

// ---- particle tracks (ECC off) ----
const far = await ev(() => { let pg = 12000; while (sim.fc.map.pageRun[pg] >= 0) pg++; return pg * 4096 + 512; });
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) for (let x = a[i] ^ b[i]; x; x >>= 1) n += x & 1; return n; };
const shot = (pa, bit, kind, dir) => ev(([pa, bit, kind, dir]) => { const before = [...sim.fc.readRam(pa - 256, 512)]; const h = sim.board.strikeAt("ram", pa, bit, kind, dir); return { before, after: [...sim.fc.readRam(pa - 256, 512)], h: h && { none: h.none, bits: h.bits, words: h.words, outcome: h.outcome } }; }, [pa, bit, kind, dir]);
const deg = (d, alongRow) => { const t = d * Math.PI / 180; return alongRow ? { x: Math.sin(t), y: -Math.cos(t), z: 0 } : { x: 0, y: -Math.cos(t), z: Math.sin(t) }; };
let sh = await shot(far, 4, "light", deg(0, true));
result("light ion straight down: exactly one bit", diff(sh.before, sh.after) === 1, JSON.stringify(sh.h));
sh = await shot(far + 32, 4, "light", deg(60, true));
result("light ion at 60°: too little charge per cell, nothing flips", diff(sh.before, sh.after) === 0 && sh.h.none, JSON.stringify(sh.h));
sh = await shot(far + 64, 7, "heavy", deg(75, true));
result("heavy ion at 75° along a row: a line of bits in one or two words", sh.h.bits >= 5 && sh.h.words <= 2, JSON.stringify(sh.h));
sh = await shot(far + 96, 4, "heavy", deg(75, false));
result("heavy ion at 75° across rows: one bit in each of several words", sh.h.bits >= 5 && sh.h.words === sh.h.bits, JSON.stringify(sh.h));

// ---- ECC ----
await ev(() => sim.applySetup({ ecc: true }));
// a free page well away from everything
const free = await ev(() => { let pg = 9000; while (sim.fc.map.pageRun[pg] >= 0) pg++; return pg * 4096 + 64; });
let r = await ev((pa) => { const before = sim.fc.readRam(pa, 1)[0]; const h = sim.board.strikeAt("ram", pa, 3); return { o: h.outcome, same: sim.fc.readRam(pa, 1)[0] === before, latent: sim.fc.latentMask(pa) }; }, free);
result("ECC on, 1 bit: corrected, memory reads right, the cell is still flipped", r.o === "corrected" && r.same && r.latent === 8, JSON.stringify(r));
r = await ev((pa) => ({ o: sim.board.strikeAt("ram", pa + 1, 0).outcome, state: sim.fc.state }), free);
result("second bit in the same word, free memory: detected, no reset (nothing reads it)", r.o === "detected-unused" && r.state === "operational", JSON.stringify(r));
await ev(() => sim.fc.scrub());
r = await ev((pa) => ({ latent: sim.fc.ecc.latent.size, retired: sim.fc.events.slice(-5).some((e) => /retired/.test(e.line)) }), free);
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
// a heavy ion at 75° along the row: a line of cells inside one word
r = await ev((pa) => ({ o: sim.board.strikeAt("ram", pa, 7, "heavy", { x: Math.sin(1.31), y: -Math.cos(1.31), z: 0 }).outcome }), used);
await sleep(300);
result("heavy ion at a low angle along a row, used memory: machine check, the computer resets", r.o === "machine-check" && await ev(() => sim.fc.fram.lastReset === "ECC machine check"), JSON.stringify(r));
result("...and comes back", await up());
await ev(() => sim.applySetup({ ecc: false }));

// with ECC on, the across-rows line is fully corrected
await ev(() => sim.applySetup({ ecc: true }));
sh = await shot(far + 1024 + 8, 4, "heavy", deg(75, false));
result("ECC on, heavy ion across rows: every bit corrected", sh.h.outcome === "corrected" && sh.h.words >= 5 && diff(sh.before, sh.after) === 0, JSON.stringify(sh.h));
await ev(() => sim.applySetup({ ecc: false }));

// ---- background radiation ----
await ev(() => { sim.bg.resetStats(); sim.applySetup({ bg: true, env: "stress", warp: 604800 }); });
await sleep(6000);
r = await ev(() => ({ ...sim.bg.s, survival: document.getElementById("survival").textContent.replace(/\s+/g, " ") }));
await ev(() => { sim.applySetup({ bg: false }); sim.fc.restoreSd(); });
result("background radiation: random strikes over the board, mission clock runs", r.strikes > 100 && r.ram > 10 && r.missionS > 3 * 86400 && /mission time/i.test(r.survival), `${r.strikes} strikes, ${r.ram} on RAM, ${r.bits} bits · ${r.survival.slice(0, 160)}`);
if (!(await ev(() => sim.fc.operational))) await up();
// time warp pauses while the flight software is down, so outages cost their real duration
r = await ev(() => { sim.applySetup({ bg: true, env: "quiet", warp: 604800 }); const upWarp = sim.bg.warpNow; const was = sim.fc.operational; sim.fc.operational = false; const downWarp = sim.bg.warpNow; sim.fc.operational = was; sim.applySetup({ bg: false }); return { upWarp, downWarp }; });
result("time warp runs only while the flight software is up", r.upWarp === 604800 && r.downWarp === 1, JSON.stringify(r));

// ---- CPU registers: a physical target on the die ----
if (!(await ev(() => sim.fc.operational))) await up();
r = await ev(() => { const before = sim.fc.cpuState().reg_xmm32s[31] >>> 0; const h = sim.board.strikeCpu("XMM7.3", 9); const after = sim.fc.cpuState().reg_xmm32s[31] >>> 0; return { x: (before ^ after) >>> 0, bits: h && h.bits }; });
result("CPU: a single-bit hit flips exactly that register bit", r.x === 1 << 9 && r.bits === 1, JSON.stringify(r));
// bit 31 (the sign bit) once hung the page: a signed shift in popcount never reached zero
r = await ev(() => { const before = sim.fc.cpuState().reg_xmm32s[30] >>> 0; const h = sim.board.strikeCpu("XMM7.2", 31); return { x: ((sim.fc.cpuState().reg_xmm32s[30] >>> 0) ^ before) >>> 0, bits: h && h.bits }; });
result("CPU: a hit on bit 31 flips the sign bit (and returns)", r.x === 0x80000000 && r.bits === 1, JSON.stringify(r));
r = await ev((d) => { const h = sim.board.strikeCpu("XMM7.2", 20, "heavy", d); return h && { bits: h.bits, regs: h.changes.map((c) => c.name) }; }, deg(80, true));
result("CPU: a heavy ion at a low angle along a row flips a run of bits in one register", r && r.bits >= 3 && r.regs.length === 1 && r.regs[0] === "XMM7.2", JSON.stringify(r));
r = await ev((d) => { const h = sim.board.strikeCpu("XMM7.1", 4, "light", d); return h && { none: !!h.none, bits: h.bits }; }, deg(0, true));
result("CPU: a light ion straight down flips one bit", r && r.bits === 1, JSON.stringify(r));
// background on the die, calibrated per register bit (2e-7 upsets per bit per day). The register hits
// above may have crashed the flight software (cFS uses SSE registers in memcpy): start from a clean boot,
// and keep the RAM and SD particles from landing so the flight software stays up and the clock keeps warping
await ev(() => sim.fc.powerCycle("ground command")); await up();
await ev(() => { window._rs = sim.board.randomStrike; sim.board.randomStrike = () => null; sim.bg.resetStats(); sim.applySetup({ bg: true, env: "stress", warp: 100 }); });
await sleep(15000);
await ev(() => { sim.applySetup({ bg: false }); sim.board.randomStrike = window._rs; }); await sleep(800);   // the mission board refreshes every 300 ms
// Particles are counted, not bits: one heavy ion flips a run of bits, so bit counts are far lumpier
// than Poisson. The particle rate is what the per-bit calibration sets (upsets per day / bits per particle).
r = await ev(() => { const s = sim.bg.s; return { cpuBits: s.cpuBits, cpu: s.cpu, days: s.missionS / 86400, ppd: sim.bg.cal.cpuParticlesPerDay * 3e6, board: document.getElementById("m-cpu").textContent }; });
const ratio = r.cpu / (r.ppd * r.days);
result("CPU background: particles on the die arrive at the calibrated rate", r.cpu > 30 && ratio > 0.65 && ratio < 1.4 && r.board === String(r.cpuBits), `${r.cpu} particles, expected ${(r.ppd * r.days).toFixed(1)} (ratio ${ratio.toFixed(2)}), ${r.cpuBits} bits flipped`);
// that much radiation also damages the SD card: restore it, then reboot clean
await ev(() => { sim.fc.restoreSd(); sim.fc.powerCycle("ground command"); });
result("...after the accelerated test, a restored card boots clean", await up(), await ev(() => sim.fc.state));
// paging switched off under the kernel (CR0 bit 31): the CPU locks up, the watchdog resets it
await ev(() => sim.applySetup({ watchdog: true }));
await ev(() => sim.board.strikeCpu("CR0", 31));
// v86 either traps (a lockup) or keeps running a kernel that can no longer reach its own memory: either way the CPU stops doing useful work
result("CPU: CR0.PG flipped: the CPU stops doing useful work", await until(() => /^(lockup|lost|hung|crashed|panic)$/.test(sim.fc.state), null, 20000), await ev(() => sim.fc.state));
result("...the watchdog resets it and it comes back", (await until(() => sim.fc.fram.lastReset === "watchdog", null, 40000)) && (await up()), await ev(() => sim.fc.fram.lastReset));

// ---- watchdog ----
await ev(() => sim.applySetup({ watchdog: true }));
await ev(() => sim.fc.sh("kill -9 $(pidof core-cpu1)"));
const wd = await until(() => sim.fc.fram.lastReset === "watchdog", null, 40000);
result("flight software killed: the watchdog resets the computer", wd, await ev(() => sim.fc.fram.lastReset));
result("...and it comes back", await up());

// ---- particle shower ----
r = await ev(() => { const run = sim.fc.map.runs.find((x) => x.label === "heap") || sim.fc.map.runs.find((x) => x.cat === "fsw"); const h = sim.board.strikeAt("ram", run.pfn * 4096 + 8, 0, "flare"); return h && { bits: h.bits, words: h.words, outcomes: h.outcomes }; });
result("flare burst flips many bits at once", r && r.bits >= 10, JSON.stringify(r));
await ev(() => sim.fc.powerCycle("ground command")); await up();

// ---- ground station: uplink any file to the SD card's data partition, run it, check Doom in lockstep ----
result("the satellite mounts its SD card's data partition at /sd", await ev(() => /SD data partition mounted at \/sd/.test(sim.fc.con)));
r = await ev(async () => {
  const bytes = new Uint8Array(300000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761 >>> 13) & 255;
  const fc = sim.fc, send = fc.radio.bind(fc); let spoiled = false;
  fc.radio = (t) => { if (!spoiled && t.startsWith("UD3:")) { spoiled = true; t = t.slice(0, -8) + (t.slice(-8, -7) === "A" ? "B" : "A") + t.slice(-7); } send(t); };
  try { const u = await sim.gs.uplink("testfile", bytes); const same = sim.fc.sdData.get("testfile").every((v, i) => v === bytes[i]); return { ok: true, resent: u.resent, same, spoiled }; }
  catch (e) { return { ok: false, err: e.message }; } finally { fc.radio = send; }
});
result("uplink: a chunk damaged on the way fails its CRC, is resent, and the file arrives intact on /sd", r.ok && r.spoiled && r.resent > 0 && r.same, JSON.stringify(r));
r = await ev(async () => { await sim.gs.remove("testfile"); return sim.gs.has("testfile"); });
result("uplink: a file can be deleted", r === false);
// any program: a script that prints, reads its input, and exits
await ev(() => sim.gs.uplink("hello.sh", new TextEncoder().encode("#!/bin/sh\necho \"hello from $(hostname), $(pwd)\"\nread x\necho \"got $x\"\n")));
await ev(() => sim.gs.start("./hello.sh"));
result("run: an uplinked script runs on the satellite and its output comes down", await until(() => sim.gs.run.lines.some((l) => l === "hello from spacey-sat1, /sd"), null, 20000), await ev(() => JSON.stringify(sim.gs.run.lines)));
await ev(() => sim.gs.stdin("ping"));
result("run: a line sent up reaches its input, and it exits", await until(() => sim.gs.run.lines.includes("got ping") && /status 0/.test(sim.gs.run.exited || ""), null, 20000), await ev(() => JSON.stringify({ lines: sim.gs.run.lines, exited: sim.gs.run.exited })));
// Doom with Freedoom: the ready-made payload
await ev(() => { document.getElementById("gs-open").click(); document.getElementById("gs-pre-doom").click(); });
result("uplink: Doom and Freedoom (27.5 MB) go up and are stored on /sd", await until(() => sim.gs.has("doom") && sim.gs.has("freedoom1.wad") && !document.getElementById("gs-pre-doom").disabled, null, 400000), await ev(() => JSON.stringify(sim.gs.files())));
const runDoom = async () => { await ev(() => { document.getElementById("gs-cmd").value = "doom -iwad freedoom1.wad -mb 16"; document.getElementById("gs-run").click(); }); return until(() => !!(sim.gs.run.lock && sim.gs.run.lock.ready && sim.gs.run.lock.twin), null, 120000); };
result("Doom: it starts on the satellite and the ground starts its own copy, from the same first frame", (await runDoom()) && await ev(() => sim.gs.run.lock.groundHash.get(-1) === sim.gs.run.lock.satReady), await ev(() => JSON.stringify(sim.gs.run.lock && { sat: sim.gs.run.lock.satReady, note: sim.gs.run.lock.twinNote, exited: sim.gs.run.exited })));
// no keys: Doom plays its attract demo, which is also driven per tic
result("Doom: 150 frames computed on the satellite match the ground's", await until(() => sim.gs.run.lock.satTic >= 150 && !sim.gs.run.lock.diverged, null, 120000), await ev(() => JSON.stringify({ satTic: sim.gs.run.lock.satTic, diverged: sim.gs.run.lock.diverged })));
await ev(() => sim.fc.requestMap()); await sleep(4000);
r = await ev(() => {
  // Doom's zone memory (anonymous pages): the level, its textures and the things in it
  const runs = sim.fc.map.runs.filter((x) => x.cat === "payload" && x.label === "anon"), pages = runs.reduce((n, x) => n + x.n, 0);
  for (let i = 0; i < 200; i++) { let k = Math.floor(Math.random() * pages), x = runs.find((q) => (k -= q.n) < 0); sim.board.strikeAt("ram", (x.pfn + x.n + k) * 4096 + Math.floor(Math.random() * 4096), i % 8); }
  return pages;
});
result("Doom: 200 bits flipped in its working memory on the satellite: the ground sees the frames differ", r > 0 && await until(() => !!(sim.gs.run.lock.diverged || sim.gs.run.exited), null, 60000), await ev(() => JSON.stringify({ diverged: sim.gs.run.lock.diverged, exited: sim.gs.run.exited })));
result("...the flight software is not affected: the payload is a separate process", await ev(() => sim.fc.operational));
// damage on the card: the monsters and items of E1M6 (the level the attract demo plays), in the game data on /sd
await ev(() => document.getElementById("gs-stop").click()); await until(() => !!sim.gs.run.exited, null, 10000);
r = await ev(() => {
  const f = sim.fc.dataLayout.find((x) => x.name === "freedoom1.wad"), w = sim.fc.sdData.get("freedoom1.wad"), v = new DataView(w.buffer, w.byteOffset);
  const n = v.getInt32(4, true), dir = v.getInt32(8, true), name = (i) => String.fromCharCode(...w.subarray(dir + 16 * i + 8, dir + 16 * i + 16)).replace(/\0.*$/, "");
  let i = 0; while (i < n && name(i) !== "E1M6") i++;
  const things = { off: v.getInt32(dir + 16 * (i + 1), true), size: v.getInt32(dir + 16 * (i + 1) + 4, true) };   // the lump after the marker
  // each thing is 10 bytes: x, y, angle, type, flags. Flip a low bit of some x and y positions only, so the
  // level still loads, with monsters and items a little out of place
  for (let k = 0; k < 12; k++) { const t = Math.floor(Math.random() * (things.size / 10)); sim.fc.hitSd(f.off + things.off + t * 10 + (k % 2) * 2, 1 << (3 + (k % 3)), { quiet: true }); }
  return { name: name(i + 1), size: things.size };
});
result("Doom: monster positions in E1M6's THINGS changed on the SD card: the next run's frames differ from the ground's", (await runDoom()) && await until(() => !!sim.gs.run.lock.diverged, null, 120000), await ev((lump) => JSON.stringify({ lump, diverged: sim.gs.run.lock && sim.gs.run.lock.diverged, exited: sim.gs.run.exited }), r));
await ev(() => { document.getElementById("gs-stop").click(); sim.fc.powerCycle("ground command"); });
result("the data partition survives a reboot", (await up()) && await ev(() => sim.gs.has("doom") && sim.gs.has("freedoom1.wad")), JSON.stringify(await ev(() => sim.gs.files())));
await ev(() => document.getElementById("gs-close").click());

// ---- SD card: latent damage, boot loop, restore ----
const exe = await ev(() => { const f = sim.fc.images.files.find((x) => x.name === "cfs/cpu1/core-cpu1"); return sim.fc.images.kernel.length + f.dataOff; });
await ev((i) => sim.board.strikeAt("sd", i, 0), exe);
r = await ev(() => ({ state: sim.fc.state, bits: sim.fc.sdDamagedBits({ boot: true }) }));
result("SD card hit on the cFS executable: running system unaffected", r.state === "operational" && r.bits === 1, JSON.stringify(r));
await ev(() => sim.fc.powerCycle("ground command"));
result("power cycle: flight software cannot start", await until(() => sim.fc.state === "badimage", null, 40000), await ev(() => sim.fc.state));
result("boot loop: FRAM counts failed boots", await until(() => sim.fc.fram.failedStreak >= 2, null, 150000), JSON.stringify(await ev(() => sim.fc.fram)));
await ev(() => sim.fc.restoreSd());
result("restore SD card: the next reset boots clean", await up(), JSON.stringify(await ev(() => sim.fc.fram)));
// the same damage, left alone: after 3 failed boots the boot loader falls back to the golden image
const g0 = await ev(() => sim.fc.fram.goldenBoots);
await ev((i) => { sim.applySetup({ golden: true, watchdog: true }); sim.board.strikeAt("sd", i, 0); sim.fc.powerCycle("ground command"); }, exe);
result("golden image: 3 failed boots in a row, the boot loader boots the golden copy", await until((g) => sim.fc.fram.goldenBoots > g, g0, 200000), JSON.stringify(await ev(() => sim.fc.fram)));
result("...it repairs the card and the flight software comes back without the ground", (await up()) && (await ev(() => sim.fc.sdDamagedBits({ boot: true }) === 0)), JSON.stringify(await ev(() => ({ state: sim.fc.state, sd: sim.fc.sdDamagedBits({ boot: true }) }))));
result("...the golden image restores only the boot partition: the data partition is kept", await ev(() => sim.gs.has("doom") && sim.gs.has("freedoom1.wad") && sim.gs.has("hello.sh")), JSON.stringify(await ev(() => sim.gs.files())));

await ev(() => sim.board.home()); await sleep(1500);
await p.screenshot({ path: "test-board.png" });
result("no page errors", errs.length === 0, errs.join(" | "));
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
