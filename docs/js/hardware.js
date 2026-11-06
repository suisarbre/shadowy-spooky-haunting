// The emulated flight computer hardware, modelled on the ISISPACE iOBC CubeSat
// on-board computer: 64 MB SDRAM, an SD card for boot storage, 512 KB FRAM for
// the boot record, a hardware watchdog. v86 provides the CPU (a 32-bit PC).
//
// Nothing here knows about Linux or cFS: the OS adapter (os/*.js) supplies the
// boot images, the console patterns and the telemetry decoding.
import { bus, hex2, hexAddr, popcount, parseCpio, cpioArchive } from "./util.js";
import { WORD, decode, bitsSet } from "./ecc.js";

export const BOOT_WINDOW_MS = 30000;   // after power-on the flight software must check in with the watchdog within this
export const SILENCE_MS = 6000;        // telemetry gap that makes the ground ask "is it still alive?"
export const SCRUB_MS = 20000;
export const GOLDEN_AFTER = 3;         // failed boots in a row (counted in FRAM) before the boot loader falls back to the golden image         // the ECC scrubber reads every word of RAM once per this period
export const RAM_MB = 64;              // iOBC SDRAM
export const SD_SPARE = 4 * 1048576;   // room on the boot storage for files the ground uplinks

// The CPU's architectural state that a particle can upset, as v86 keeps it (32-bit x86).
// Each entry is one row of cells on the CPU die: { name, bits, get(cpu), set(cpu, v) }.
const r32 = (arr, i) => ({ get: (c) => c[arr][i] >>> 0, set: (c, v) => { c[arr][i] = v | 0; } });
export const CPU_REGS = [
  ...["EAX", "ECX", "EDX", "EBX", "ESP", "EBP", "ESI", "EDI"].map((name, i) => ({ name, group: "int", bits: 32, ...r32("reg32", i) })),
  { name: "EIP", group: "ctl", bits: 32, ...r32("instruction_pointer", 0) },
  // v86 computes some flags lazily: settle them first, then the stored word is the real EFLAGS
  { name: "EFLAGS", group: "ctl", bits: 32, get: (c) => c.get_eflags() >>> 0, set: (c, v) => { c.flags[0] = v | 0; c.flags_changed[0] = 0; } },
  ...["ES", "CS", "SS", "DS", "FS", "GS"].map((name, i) => ({ name, group: "seg", bits: 16, get: (c) => c.sreg[i], set: (c, v) => { c.sreg[i] = v & 0xffff; } })),
  ...[0, 2, 3, 4].map((i) => ({ name: "CR" + i, group: "cr", bits: 32, ...r32("cr", i) })),
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((x) => [0, 1, 2, 3].map((l) => ({ name: `XMM${x}.${l}`, group: "sse", bits: 32, ...r32("reg_xmm32s", x * 4 + l) }))),
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((x) => [1, 0].map((l) => ({ name: `ST${x}.${l ? "hi" : "lo"}`, group: "fpu", bits: 32, ...r32("fpu_st", x * 4 + l) }))),
];
export const CPU_BITS = CPU_REGS.reduce((n, r) => n + r.bits, 0);

export class FlightComputer {
  constructor(os, images, { screen = null } = {}) {
    this.os = os; this.images = images; this.screenEl = screen;
    // v86 always loads the root filesystem image at the 64 MB mark, so the PC gets
    // just enough extra RAM to hold it (the kernel frees that area after unpacking).
    this.memMb = RAM_MB + Math.ceil((images.fs.length + SD_SPARE) / 1048576) + 1;
    this.pages = this.memMb * 256;
    // SD card: the boot storage as it is now, damage included
    this.sd = { kernel: images.kernel.slice(), fs: images.fs.slice(), diffs: new Map() };
    this.sdFiles = images.files;
    // FRAM: non-volatile and immune to bit flips, so it keeps the boot record across resets
    this.fram = { boots: 0, failedStreak: 0, wdResets: 0, mcResets: 0, goldenBoots: 0, lastReset: "first power-on" };
    // the golden image: a write-protected copy of the launch image on the second SD card (the iOBC has
    // two card slots). The boot loader falls back to it after GOLDEN_AFTER failed boots in a row.
    this.golden = { on: true };
    // memory controller ECC; flipped cells it is hiding, per 8-byte word
    this.ecc = { on: false, latent: new Map(), corrected: 0, detected: 0, silent: 0, scrubbed: 0, overwritten: 0, lastScrub: Date.now() };
    this.watchdogConnected = true;
    this.events = [];
    this.powerOn();
  }

  emit(type, data = {}) { bus.emit(type, { fc: this, ...data }); }
  log(line, src = "hw") { const e = { t: Date.now(), line, src }; this.events.push(e); if (this.events.length > 400) this.events.splice(0, 150); bus.emit("log", e); }

  // ---------------------------------------------------------------- power
  powerOn() {
    Object.assign(this, { con: "", rx: ["", "", "", ""], mapBuf: null, map: null, started: false, operational: false, probing: false, lastTlm: 0,
      reachedOperational: false, autostartSeen: false, bootTimer: null, exitSeen: false, panicSeen: false, app: this.os.freshApp(), tlmCounts: new Map() });
    this.ecc.latent.clear();   // DRAM loses its contents without power
    // like real watchdog chips, this one runs from the moment power comes on
    this.wd = { enabled: this.watchdogConnected, timeoutMs: BOOT_WINDOW_MS, lastKick: Date.now(), byFsw: false };
    this.fram.boots++;
    this.bootSource = "primary";
    if (this.golden.on && this.fram.failedStreak >= GOLDEN_AFTER) {
      // the boot loader reads the failure count from FRAM, boots the golden copy and writes it over the primary card
      this.bootSource = "golden"; this.fram.goldenBoots++;
      this.sd.kernel = this.images.kernel.slice(); this.sd.fs = this.images.fs.slice(); this.sd.diffs.clear(); this.sdFiles = this.images.files;
      this.log(`BOOT LOADER: ${this.fram.failedStreak} failed boots in a row (FRAM) · booting the golden image from SD card 2 and copying it over SD card 1`);
      this.emit("sd-restore"); this.emit("golden-boot");
    }
    this.setState(this.bootSource === "golden" ? "golden" : this.fram.failedStreak >= 2 ? "bootloop" : "booting");
    const { bios, vga } = this.images;
    this.emu = new window.V86({
      wasm_path: `v86.wasm?v=${window.BUILD}`,
      bios: { buffer: bios.slice(0) }, vga_bios: { buffer: vga.slice(0) },
      bzimage: { buffer: this.sd.kernel.slice().buffer },
      initrd: { buffer: this.sd.fs.slice().buffer },
      cmdline: this.os.cmdline,
      memory_size: this.memMb * 1024 * 1024,
      uart1: true, uart2: true, uart3: true, autostart: true, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
      // the computer's VGA output, shown by the ground station panel (the payload draws on it)
      ...(this.screenEl ? { screen_container: this.screenEl } : {}),
    });
    for (let n = 0; n < 4; n++) this.emu.add_listener(`serial${n}-output-byte`, (b) => this.onSerial(n, b));
    // A corrupted register can put the emulator in a state it was never meant to reach, and v86
    // stops with a WebAssembly trap. That is this model's CPU lockup: the core stops executing,
    // nothing more is printed or kicked, and only a reset (the watchdog) brings it back.
    const emu = this.emu;
    emu.add_listener("emulator-ready", () => {
      const v = emu.v86; if (!v) return; const tick = v.do_tick.bind(v);
      v.do_tick = () => { try { tick(); } catch (e) { v.running = false; if (this.emu === emu) this.cpuLockup(e); } };
    });
    this.emit("power-on");
  }
  async powerCycle(reason) {
    this.fram.lastReset = reason;
    const old = this.emu; this.emu = null; clearTimeout(this.bootTimer);
    this.emit("reset", { reason });
    // a locked-up emulator never reports that it stopped, so do not wait for it for long
    try { await Promise.race([old.destroy(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* already gone */ }
    this.powerOn();
  }

  cpuLockup(e) {
    if (this.state === "lockup") return;
    const was = this.operational;
    this.operational = false; this.started = false; this.probing = false;
    this.log(`CPU LOCKUP: the processor stopped executing (emulator trap: ${String(e && e.message || e).slice(0, 60)}) · ${this.wd.enabled ? "the watchdog will reset it" : "no watchdog: it stays stopped until a power cycle"}`);
    this.setState("lockup");
    if (was) this.emit("fsw-down", { why: "lockup" });
  }
  // state: booting | bootloop | starting | operational | lost | crashed | hung | exited | badimage | panic | lockup | golden
  setState(state, detail = "") { this.state = state; this.stateDetail = detail; this.emit("state", { state, detail }); }

  sh(cmd) { if (this.emu) this.emu.serial0_send(cmd + "\n"); }
  // one line on the radio link (file uplink and payload channel; see build/serbridge.c)
  radio(text) { if (this.emu) this.emu.serial_send_bytes(1, new TextEncoder().encode(text + "\n")); }
  send(packet) { if (this.emu) this.emu.serial_send_bytes(1, new TextEncoder().encode("C" + [...packet].map(hex2).join("") + "\n")); }

  onSerial(n, byte) {
    if (n === 0) return this.onConsole(byte);
    const c = String.fromCharCode(byte);
    if (c !== "\n") { this.rx[n] += c; return; }
    const line = this.rx[n]; this.rx[n] = "";
    if (n === 1) this.onRadio(line); else if (n === 2) this.onWatchdogBus(line.trim()); else this.onDiag(line);
  }

  // ---------------------------------------------------------------- console (ttyS0)
  onConsole(byte) {
    this.con += String.fromCharCode(byte);
    if (this.con.length > 20000) this.con = this.con.slice(-15000);
    bus.emit("console", { fc: this });
    const P = this.os.patterns, tail = this.con.slice(-300);
    if (!this.autostartSeen && P.fswStarting.test(tail)) { this.autostartSeen = true; this.started = true; this.setState("starting"); }
    if (P.shellReady.test(tail) && !this.started && !this.autostartSeen && !this.bootTimer) {
      this.bootTimer = setTimeout(() => { if (!this.started && !this.autostartSeen && this.emu) { this.started = true; this.setState("starting"); this.sh(this.os.startCommand); } }, 4000);
    }
    if (P.operational.test(tail) && this.started && !this.operational) {
      this.operational = true; this.reachedOperational = true; this.fram.failedStreak = 0; this.lastTlm = Date.now();
      this.setState("operational");
      this.os.onOperational(this);
      setTimeout(() => this.requestMap(), 1500);
    }
    const exit = tail.match(P.fswExit);
    if (exit && !this.exitSeen) {
      this.exitSeen = true; this.started = false; this.operational = false; this.probing = false;
      if (P.corruptExec.test(this.con.slice(-1500))) this.setState("badimage"); else this.setState("exited", exit[1]);
      this.emit("fsw-down", { why: this.state });
    }
    if (P.panic.test(tail) && !this.panicSeen) { this.panicSeen = true; this.operational = false; this.setState("panic"); this.emit("fsw-down", { why: "panic" }); }
    if (P.probeDown.test(tail) && this.probing) {
      this.probing = false; this.started = false; this.operational = false; this.con += "\n";
      this.setState("crashed"); this.emit("fsw-down", { why: "crashed" });
    }
    if (P.probeAlive.test(tail) && this.probing) { this.probing = false; this.lastTlm = Date.now(); this.con += "\n"; this.setState("hung"); }
  }

  // ---------------------------------------------------------------- radio (ttyS1)
  onRadio(line) {
    if (line[0] === "U") return this.emit("uplink-reply", { line });
    if (line[0] === "P") return this.emit("payload", { line: line.slice(1) });
    if (line[0] !== "T") return;
    const hex = line.slice(1), b = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    this.lastTlm = Date.now();
    if (this.state === "hung" && this.operational) this.setState("operational");
    const mid = (b[0] << 8) | b[1];
    this.tlmCounts.set(mid, (this.tlmCounts.get(mid) || 0) + 1);
    this.os.telemetry(this, b);
    this.emit("telemetry", { mid });
  }

  // ---------------------------------------------------------------- watchdog chip (ttyS2)
  onWatchdogBus(line) {
    if (line.startsWith("WS")) this.wd.timeoutMs = parseInt(line.slice(2), 10) || 0;
    else if (line === "WE") { this.wd.enabled = this.watchdogConnected; this.wd.byFsw = true; this.wd.lastKick = Date.now(); }
    else if (line === "WD") this.wd.enabled = false;
    else if (line === "WK") this.wd.lastKick = Date.now();
  }
  setWatchdog(on) {
    this.watchdogConnected = on;
    if (on) { this.wd.lastKick = Date.now(); this.wd.enabled = true; } else this.wd.enabled = false;
    this.emit("settings");
  }

  // ---------------------------------------------------------------- diagnostics (ttyS3): physical memory map
  requestMap() { if (this.emu) this.emu.serial_send_bytes(3, new TextEncoder().encode("M\n")); }
  onDiag(l) {
    if (l === "MB") this.mapBuf = [];
    else if (l.startsWith("ME") && this.mapBuf) { this.map = this.buildMap(this.mapBuf); this.mapBuf = null; this.emit("map"); }
    else if (this.mapBuf) this.mapBuf.push(l);
  }
  buildMap(lines) {
    const runs = [], pageRun = new Int32Array(this.pages).fill(-1);
    for (const l of lines) {
      const f = l.split(" ");
      if (f[0] === "K") runs.push({ pfn: parseInt(f[1], 16), n: parseInt(f[2], 16), label: f[3].replace(/_/g, " "), comm: "", cat: "kernel" });
      else if (f[0] === "R") runs.push({ pfn: parseInt(f[1], 16), n: parseInt(f[2], 16), va: parseInt(f[3], 16), pid: parseInt(f[4], 16), comm: f[5], label: f[6], cat: this.os.categorize(f[5], f[6]) });
    }
    // first claim wins: the guest lists the kernel, then the flight software, then everyone else
    runs.forEach((r, i) => { for (let k = 0; k < r.n; k++) { const p = r.pfn + k; if (p < this.pages && pageRun[p] < 0) pageRun[p] = i; } });
    return { runs, pageRun, t: Date.now() };
  }
  // what lives at a physical address right now
  describe(pa) {
    const pg = pa >>> 12;
    if (!this.map) return { label: "unknown (no memory map yet)", cat: "free" };
    const r = this.map.pageRun[pg];
    if (r === undefined || r < 0) return { label: "free memory", cat: "free" };
    const run = this.map.runs[r];
    const va = run.va !== undefined ? run.va + (pg - run.pfn) * 4096 + (pa & 4095) : null;
    return { label: run.comm ? `${run.comm} ${run.label}` : run.label, cat: run.cat, va, run };
  }
  findRun(label) { return this.map && this.map.runs.find((r) => r.label === label); }

  // ---------------------------------------------------------------- RAM
  // v86 hands back a live view of its memory: copy it
  readRam(pa, n) { try { return this.emu ? this.emu.read_memory(pa, n).slice() : null; } catch (e) { return null; } }
  // live view without a copy, for drawing large areas (valid until the next emulator step)
  viewRam(pa, n) { try { return this.emu ? this.emu.read_memory(pa, n) : null; } catch (e) { return null; } }
  // bits the ECC is hiding at a byte (flipped in the DRAM cells, corrected on every read)
  latentMask(pa) { const w = this.ecc.latent.get(pa - (pa % WORD)); return w ? w.e[pa % WORD] : 0; }

  // A particle flips bits in one byte of physical RAM.
  //  ECC off: the bits flip; software reads whatever it now holds.
  //  ECC on:  the controller decodes the word on every read. One wrong bit is corrected
  //           (the cell stays flipped until the scrubber or a write fixes it); two are
  //           detected and raise a machine check, which resets the computer; three or
  //           more may be "corrected" into the wrong value without any alarm.
  hitRam(pa, mask, opts) { return this.hitRamMany([{ pa, mask }], opts); }
  // One particle can flip several cells at once. They are applied together and
  // each 8-byte word is decoded once with all its new errors, as the controller
  // would see them on the next read.
  hitRamMany(cells, { quiet = false } = {}) {
    if (!this.emu || !cells.length) return null;
    const words = new Map();
    for (const { pa, mask } of cells) {
      if (!mask || pa >= this.pages * 4096) continue;
      const base = pa - (pa % WORD);
      if (!words.has(base)) words.set(base, new Uint8Array(WORD));
      words.get(base)[pa % WORD] ^= mask;
    }
    const results = [];
    for (const [base, e] of words) { const r = this.hitWord(base, e); if (r) results.push(r); }
    if (!results.length) return null;
    const RANK = ["cancelled", "landed", "corrected", "detected-unused", "silent", "machine-check"];
    const worst = results.reduce((a, b) => (RANK.indexOf(b.outcome) > RANK.indexOf(a.outcome) ? b : a));
    const outcomes = {}; let bits = 0;
    for (const r of results) { outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1; bits += r.bits; }
    const first = cells[0], what = this.describe(first.pa);
    const text = results.length === 1 ? worst.text : `${bits} bits in ${results.length} words: ${Object.entries(outcomes).map(([k, n]) => `${n} ${k}`).join(", ")}${worst.outcome === "machine-check" ? " · machine check, the computer resets" : ""}`;
    if (!quiet) this.log(`RAM hit ${hexAddr(first.pa)}${bits > 1 ? ` (${bits} bits)` : ` mask 0x${hex2(first.mask)}`} · ${what.label} · ${text}`);
    const r = { pa: first.pa, mask: first.mask, what, outcome: worst.outcome, text, bits, words: results.length, outcomes, results };
    this.emit("ram-hit", r);
    if (worst.outcome === "machine-check") { this.fram.mcResets++; this.log("MACHINE CHECK: uncorrectable memory error, hardware reset"); this.powerCycle("ECC machine check"); }
    return r;
  }
  hitWord(base, e) {
    const now = this.readRam(base, WORD); if (!now) return null;
    const k = e.findIndex((x) => x), what = this.describe(base + k), bits = bitsSet(e);
    if (!this.ecc.on) {
      this.emu.write_memory(now.map((v, i) => v ^ e[i]), base);
      return { outcome: "landed", bits, what, text: bits === 1 ? `landed (${hex2(now[k])}→${hex2(now[k] ^ e[k])})` : `${bits} bits landed` };
    }
    let w = this.ecc.latent.get(base);
    if (w && !sameBytes(now, w.ref)) { this.ecc.latent.delete(base); w = null; }   // software rewrote the word since: old error gone
    if (!w) w = { e: new Uint8Array(WORD), ref: now, t: Date.now() };
    for (let i = 0; i < WORD; i++) w.e[i] ^= e[i];
    const d = decode(w.e), n = bitsSet(w.e);
    if (d.kind === "clean") { this.ecc.latent.delete(base); return { outcome: "cancelled", bits, what, text: "flipped the same cell back: no error left" }; }
    if (d.kind === "corrected") { this.ecc.latent.set(base, w); this.ecc.corrected++; return { outcome: "corrected", bits, what, text: "corrected by ECC (cell stays flipped until the scrubber passes)" }; }
    if (d.kind === "detected") {
      this.ecc.detected++;
      if (what.cat === "free") { this.ecc.latent.set(base, w); return { outcome: "detected-unused", bits, what, text: `ECC detected a ${n}-bit error it cannot fix, in free memory: nothing reads it yet` }; }
      return { outcome: "machine-check", bits, what, text: `ECC detected a ${n}-bit error it cannot fix: machine check, the computer resets` };
    }
    // the decoder "fixed" the wrong bit or saw nothing: software reads a wrong value, with no alarm
    this.ecc.latent.delete(base); this.ecc.silent++;
    this.emu.write_memory(now.map((v, i) => v ^ d.residual[i]), base);
    return { outcome: "silent", bits, what, text: `${n} bits wrong in one word: ECC miscorrected it, software now reads a wrong value with no alarm` };
  }

  setEcc(on) {
    if (this.ecc.on && !on && this.emu) {
      // without the decoder, every flipped cell shows up as it is
      for (const [base, w] of this.ecc.latent) { const now = this.readRam(base, WORD); if (now && sameBytes(now, w.ref)) this.emu.write_memory(now.map((v, i) => v ^ w.e[i]), base); }
      if (this.ecc.latent.size) this.log(`ECC off: ${this.ecc.latent.size} word(s) it was hiding are now wrong in memory`);
    }
    this.ecc.latent.clear(); this.ecc.on = on; this.ecc.lastScrub = Date.now();
    this.emit("settings");
  }

  // The scrubber walks all of RAM, reading and rewriting every word: single-bit
  // errors get written back corrected before a second hit can join them.
  scrub() {
    let fixed = 0, retired = 0;
    for (const [base, w] of this.ecc.latent) {
      const now = this.readRam(base, WORD);
      if (now && !sameBytes(now, w.ref)) { this.ecc.overwritten++; continue; }
      const d = decode(w.e);
      if (d.kind === "corrected") fixed++; else retired++;
    }
    this.ecc.latent.clear(); this.ecc.scrubbed += fixed; this.ecc.lastScrub = Date.now();
    if (fixed || retired) this.log(`ECC scrubber: rewrote ${fixed} corrected word(s)${retired ? `, found ${retired} uncorrectable word(s) in free memory (page retired)` : ""}`);
    this.emit("scrub", { fixed, retired });
  }

  // ---------------------------------------------------------------- CPU registers
  // No ECC here: an upset register feeds straight into whatever the CPU does next.
  cpuState() { return this.emu && this.emu.v86 && this.emu.v86.cpu; }
  readReg(r) { const c = this.cpuState(); try { return c ? r.get(c) : null; } catch (e) { return null; } }
  hitCpu(cells, { quiet = false } = {}) {
    const c = this.cpuState(); if (!c || !cells.length) return null;
    const masks = new Map();
    for (const { reg, bit } of cells) masks.set(reg, (masks.get(reg) || 0) ^ (1 << bit));
    const changes = [];
    for (const [r, m] of masks) {
      if (!m) continue;
      const before = r.get(c), after = (before ^ m) >>> 0;
      r.set(c, after); changes.push({ name: r.name, before, after: r.get(c), bits: popcount(m >>> 0) });
    }
    if (!changes.length) return null;
    const bits = changes.reduce((n, x) => n + x.bits, 0), hx = (v, w) => "0x" + v.toString(16).padStart(w / 4, "0");
    const text = changes.map((x) => { const r = CPU_REGS.find((q) => q.name === x.name); return `${x.name} ${hx(x.before, r.bits)}→${hx(x.after, r.bits)}`; }).join(", ");
    if (!quiet) this.log(`CPU hit · ${bits} bit${bits > 1 ? "s" : ""} · ${text} · no protection: the CPU carries on with it`);
    const r = { bits, changes, text };
    this.emit("cpu-hit", r);
    return r;
  }

  // ---------------------------------------------------------------- SD card (boot storage)
  // Damage there changes nothing until the next boot reads it.
  sdBytes() { return this.sd.kernel.length + this.sd.fs.length; }
  sdCapacity() { return this.images.kernel.length + this.images.fs.length + SD_SPARE; }
  describeSd(index) {
    const kl = this.images.kernel.length;
    if (index >= this.sdBytes()) return { label: "free space", cat: "free" };
    if (index < kl) return { label: "kernel image", cat: "kernel" };
    const off = index - kl, f = this.sdFiles.find((x) => off >= x.dataOff && off < x.dataOff + x.size);
    return f ? { label: `file ${f.name} +0x${(off - f.dataOff).toString(16)}`, cat: this.os.categorizeFile(f.name), file: f.name } : { label: "filesystem metadata", cat: "other" };
  }
  readSd(index, n) {
    const kl = this.sd.kernel.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const x = index + i; out[i] = x < kl ? this.sd.kernel[x] : this.sd.fs[x - kl] ?? 0; }
    return out;
  }
  hitSd(index, mask, opts) { return this.hitSdMany([{ index, mask }], opts); }
  hitSdMany(cells, { quiet = false } = {}) {
    const kl = this.sd.kernel.length, hit = [];
    for (const { index, mask } of cells) {
      const inK = index < kl, area = inK ? this.sd.kernel : this.sd.fs, abs = inK ? index : index - kl;
      if (!mask || abs >= area.length) continue;
      area[abs] ^= mask;
      const x = (this.sd.diffs.get(index) || 0) ^ mask;
      if (x) this.sd.diffs.set(index, x); else this.sd.diffs.delete(index);
      hit.push({ index, mask, what: this.describeSd(index) });
    }
    if (!hit.length) return null;
    // report the most important thing damaged
    const ORDER = ["kernel", "fsw", "app", "payload", "lib", "other"], main = hit.reduce((a, b) => (ORDER.indexOf(b.what.cat) < ORDER.indexOf(a.what.cat) ? b : a));
    const bits = hit.reduce((n, h) => n + popcount(h.mask), 0);
    if (!quiet) this.log(`SD card hit byte ${main.index}${bits > 1 ? ` (${bits} bits)` : ` mask 0x${hex2(main.mask)}`} · ${main.what.label} · nothing happens until the next boot reads it`);
    const r = { index: main.index, mask: main.mask, what: main.what, bits };
    this.emit("sd-hit", r);
    return r;
  }
  setGolden(on) { this.golden.on = on; this.log(`Golden image fallback ${on ? "on" : "off"}${on ? ` (after ${GOLDEN_AFTER} failed boots in a row)` : ": a damaged card boot-loops until the ground restores it"}`); }
  // A file the flight software received and verified is written to the SD card, so it is still
  // there after a reboot. In the model the boot storage is the initramfs image, so the file is
  // appended to it as one more cpio archive (the kernel unpacks archives one after another).
  sdFree() { return this.images.fs.length + SD_SPARE - this.sd.fs.length; }
  writeSdFile(path, bytes) {
    const arc = cpioArchive([{ name: path.split("/").slice(0, -1).join("/"), dir: true }, { name: path, data: bytes }]);
    if (arc.length > this.sdFree()) return false;
    const fs = new Uint8Array(this.sd.fs.length + arc.length); fs.set(this.sd.fs); fs.set(arc, this.sd.fs.length);
    this.sd.fs = fs; this.sdFiles = parseCpio(fs);
    this.emit("sd-write", { path, size: bytes.length });
    return true;
  }
  restoreSd() {
    this.sd.kernel = this.images.kernel.slice(); this.sd.fs = this.images.fs.slice(); this.sd.diffs.clear(); this.sdFiles = this.images.files;
    this.log("SD card restored from the launch image (ground re-upload)"); this.emit("sd-restore");
  }
  sdDamagedBits() { let n = 0; for (const v of this.sd.diffs.values()) n += popcount(v); return n; }

  // ---------------------------------------------------------------- once a second
  tick() {
    if (!this.emu) return;
    const now = Date.now();
    if (this.wd.enabled && this.wd.timeoutMs && now - this.wd.lastKick > this.wd.timeoutMs) {
      this.wd.enabled = false; this.fram.wdResets++;
      if (!this.reachedOperational) this.fram.failedStreak++;
      this.log(`WATCHDOG: no kick for ${((now - this.wd.lastKick) / 1000).toFixed(1)} s, hardware reset`);
      this.powerCycle("watchdog"); return;
    }
    if (this.operational && now - this.lastTlm > SILENCE_MS && !this.probing) {
      this.probing = true; this.setState("lost");
      this.sh(this.os.probeCommand);
    }
    // a word software has rewritten no longer holds the old error
    for (const [base, w] of this.ecc.latent) { const v = this.readRam(base, WORD); if (v && !sameBytes(v, w.ref)) { this.ecc.latent.delete(base); this.ecc.overwritten++; this.emit("ecc-overwritten", { base }); } }
    if (this.ecc.on && now - this.ecc.lastScrub >= SCRUB_MS) this.scrub();
  }
}

function sameBytes(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
