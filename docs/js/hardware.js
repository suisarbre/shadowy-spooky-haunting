// The emulated flight computer hardware, modelled on the ISISPACE iOBC CubeSat
// on-board computer: 64 MB SDRAM, an SD card for boot storage, 512 KB FRAM for
// the boot record, a hardware watchdog. v86 provides the CPU (a 32-bit PC).
//
// Nothing here knows about Linux or cFS: the OS adapter (os/*.js) supplies the
// boot images, the console patterns and the telemetry decoding.
import { bus, hex2, hexAddr, popcount } from "./util.js";
import { WORD, decode, bitsSet } from "./ecc.js";

export const BOOT_WINDOW_MS = 30000;   // after power-on the flight software must check in with the watchdog within this
export const SILENCE_MS = 6000;        // telemetry gap that makes the ground ask "is it still alive?"
export const SCRUB_MS = 20000;         // the ECC scrubber reads every word of RAM once per this period
export const RAM_MB = 64;              // iOBC SDRAM

export class FlightComputer {
  constructor(os, images) {
    this.os = os; this.images = images;
    // v86 always loads the root filesystem image at the 64 MB mark, so the PC gets
    // just enough extra RAM to hold it (the kernel frees that area after unpacking).
    this.memMb = RAM_MB + Math.ceil(images.fs.length / 1048576) + 1;
    this.pages = this.memMb * 256;
    // SD card: the boot storage as it is now, damage included
    this.sd = { kernel: images.kernel.slice(), fs: images.fs.slice(), diffs: new Map() };
    // FRAM: non-volatile and immune to bit flips, so it keeps the boot record across resets
    this.fram = { boots: 0, failedStreak: 0, wdResets: 0, mcResets: 0, lastReset: "first power-on" };
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
    this.setState(this.fram.failedStreak >= 2 ? "bootloop" : "booting");
    const { bios, vga } = this.images;
    this.emu = new window.V86({
      wasm_path: `v86.wasm?v=${window.BUILD}`,
      bios: { buffer: bios.slice(0) }, vga_bios: { buffer: vga.slice(0) },
      bzimage: { buffer: this.sd.kernel.slice().buffer },
      initrd: { buffer: this.sd.fs.slice().buffer },
      cmdline: this.os.cmdline,
      memory_size: this.memMb * 1024 * 1024,
      uart1: true, uart2: true, uart3: true, autostart: true, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    });
    for (let n = 0; n < 4; n++) this.emu.add_listener(`serial${n}-output-byte`, (b) => this.onSerial(n, b));
    this.emit("power-on");
  }
  async powerCycle(reason) {
    this.fram.lastReset = reason;
    const old = this.emu; this.emu = null; clearTimeout(this.bootTimer);
    this.emit("reset", { reason });
    try { await old.destroy(); } catch (e) { /* already gone */ }
    this.powerOn();
  }

  // state: booting | bootloop | starting | operational | lost | crashed | hung | exited | badimage | panic
  setState(state, detail = "") { this.state = state; this.stateDetail = detail; this.emit("state", { state, detail }); }

  sh(cmd) { if (this.emu) this.emu.serial0_send(cmd + "\n"); }
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
  hitRam(pa, mask, { quiet = false } = {}) {
    if (!this.emu) return null;
    const what = this.describe(pa);
    let outcome, text;
    const before = this.readRam(pa, 1); if (!before) return null;
    if (!this.ecc.on) {
      this.emu.write_memory([before[0] ^ mask], pa);
      outcome = "landed"; text = `landed (${hex2(before[0])}→${hex2(before[0] ^ mask)})`;
    } else {
      const base = pa - (pa % WORD);
      let w = this.ecc.latent.get(base);
      const now = this.readRam(base, WORD);
      if (w && !sameBytes(now, w.ref)) { this.ecc.latent.delete(base); w = null; }   // software rewrote the word since: old error gone
      if (!w) w = { e: new Uint8Array(WORD), ref: now, t: Date.now() };
      w.e[pa % WORD] ^= mask;
      const d = decode(w.e);
      if (d.kind === "clean") { this.ecc.latent.delete(base); outcome = "cancelled"; text = "flipped the same cell back: no error left"; }
      else if (d.kind === "corrected") { this.ecc.latent.set(base, w); this.ecc.corrected++; outcome = "corrected"; text = "corrected by ECC (cell stays flipped until the scrubber passes)"; }
      else if (d.kind === "detected") {
        this.ecc.detected++;
        if (what.cat === "free") { this.ecc.latent.set(base, w); outcome = "detected-unused"; text = `ECC detected a ${bitsSet(w.e)}-bit error it cannot fix, in free memory: nothing reads it yet`; }
        else { outcome = "machine-check"; text = `ECC detected a ${bitsSet(w.e)}-bit error it cannot fix: machine check, the computer resets`; }
      } else {
        // the decoder "fixed" the wrong bit or saw nothing: software reads a wrong value, with no alarm
        this.ecc.latent.delete(base); this.ecc.silent++;
        const out = new Uint8Array(WORD); for (let i = 0; i < WORD; i++) out[i] = now[i] ^ d.residual[i];
        this.emu.write_memory(out, base);
        outcome = "silent"; text = `${bitsSet(w.e)} bits wrong in one word: ECC miscorrected it, software now reads a wrong value with no alarm`;
      }
    }
    if (!quiet) this.log(`RAM hit ${hexAddr(pa)} mask 0x${hex2(mask)} (${popcount(mask)} bit${popcount(mask) > 1 ? "s" : ""}) · ${what.label} · ${text}`);
    const r = { pa, mask, what, outcome, text };
    this.emit("ram-hit", r);
    if (outcome === "machine-check") { this.fram.mcResets++; this.log("MACHINE CHECK: uncorrectable memory error, hardware reset"); this.powerCycle("ECC machine check"); }
    return r;
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

  // ---------------------------------------------------------------- SD card (boot storage)
  // Damage there changes nothing until the next boot reads it.
  sdBytes() { return this.sd.kernel.length + this.sd.fs.length; }
  describeSd(index) {
    const kl = this.images.kernel.length;
    if (index < kl) return { label: "kernel image", cat: "kernel" };
    const off = index - kl, f = this.images.files.find((x) => off >= x.dataOff && off < x.dataOff + x.size);
    return f ? { label: `file ${f.name} +0x${(off - f.dataOff).toString(16)}`, cat: this.os.categorizeFile(f.name), file: f.name } : { label: "filesystem metadata", cat: "other" };
  }
  readSd(index, n) {
    const kl = this.sd.kernel.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const x = index + i; out[i] = x < kl ? this.sd.kernel[x] : this.sd.fs[x - kl] ?? 0; }
    return out;
  }
  hitSd(index, mask) {
    const kl = this.sd.kernel.length, inK = index < kl, area = inK ? this.sd.kernel : this.sd.fs, abs = inK ? index : index - kl;
    if (abs >= area.length) return null;
    const what = this.describeSd(index), before = area[abs];
    area[abs] ^= mask;
    const x = (this.sd.diffs.get(index) || 0) ^ mask;
    if (x) this.sd.diffs.set(index, x); else this.sd.diffs.delete(index);
    this.log(`SD card hit byte ${index} mask 0x${hex2(mask)} · ${what.label} · ${hex2(before)}→${hex2(area[abs])}, nothing happens until the next boot reads it`);
    const r = { index, mask, what };
    this.emit("sd-hit", r);
    return r;
  }
  restoreSd() {
    this.sd.kernel = this.images.kernel.slice(); this.sd.fs = this.images.fs.slice(); this.sd.diffs.clear();
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
