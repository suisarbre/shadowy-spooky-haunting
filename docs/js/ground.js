// The ground station: uplinks files to the satellite's SD card, runs programs there, and checks
// programs that can run on the ground too.
//
// Uplink: a file goes up gzip-compressed in base64 chunks with a CRC-32 each, over the same radio
// link as commands (build/serbridge.c has the other side). The satellite acknowledges each chunk in
// order; a bad or missing chunk is resent (go-back-N, a window of chunks in flight). When the whole
// file checks out, the satellite unpacks it onto the SD card's data partition, mounted at /sd.
//
// Running: any program or script on /sd, with a command line, its output downlinked line by line and
// lines typed on the ground sent to its standard input.
//
// Lockstep: a program that prints "@@R<hash>" when it starts speaks the lockstep protocol. The
// ground then sends it one line per tic, "G<tic>:<key events>", and it answers each with
// "@@D<tic>:<frame hash>". When the ground has a copy of the same program (Doom: the same source
// built for WebAssembly) and of the files it opens, it runs the same tics itself: the program is
// deterministic, so every hash must match, and the first one that does not is where something
// (radiation, a damaged file) changed what the satellite computed.
import { bus } from "./util.js";
import { GroundDoom } from "./doom-ground.js";

const CHUNK = 2048, WINDOW = 8, ACK_TIMEOUT_MS = 6000;
export const LINK_BPS = 9600;   // a typical CubeSat UHF uplink, for comparison

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export function crc32(bytes, c = 0) { c = ~c >>> 0; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
const hx = (n) => (n >>> 0).toString(16).padStart(8, "0");
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
export async function gzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()); }
export async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }
export const validName = (n) => /^[A-Za-z0-9._+-]{1,64}$/.test(n) && !n.startsWith(".");
// split a command line the way sh would for simple cases: words, with '...' or "..." quoting
export const splitArgs = (s) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

export class GroundStation {
  constructor({ fc }) {
    this.fc = fc; this.busy = null; this.run = null;
    this.local = new Map();   // the ground's copy of every file it uplinked (name -> bytes)
    this.twins = new Map();   // programs the ground can run too: name on the satellite -> async (args, files) => twin
    bus.on("uplink-reply", (e) => this.onReply(e.line));
    bus.on("payload", (e) => this.onPayload(e.line));
    bus.on("power-on", () => {
      if (this.busy) this.busy.fail("the satellite rebooted during the upload");
      if (this.run && !this.run.exited) { this.run.exited = "the satellite rebooted"; bus.emit("run", { run: this.run }); }
    });
  }
  // files on the SD card's data partition
  files() { return [...this.fc.sdData].map(([name, d]) => ({ name, size: d.length })); }
  has(name) { return this.fc.sdData.has(name); }

  // ---- uplink ----
  // bytes: the file; gz: the same file already gzip-compressed (optional). onProgress({ sent, total, rate, resent })
  async uplink(name, bytes, { gz = null, onProgress = () => {} } = {}) {
    if (this.busy) throw new Error("an upload is already running");
    if (!validName(name)) throw new Error(`"${name}": use letters, digits and . _ + - only`);
    if (!this.fc.emu || !this.fc.emu.fs9p) throw new Error("the satellite is off");
    gz = gz || await gzip(bytes);
    if (bytes.length > this.fc.sdFree() + (this.has(name) ? this.fc.sdData.get(name).length : 0)) throw new Error(`not enough room on the SD card's data partition (${(bytes.length / 1048576).toFixed(1)} MB needed, ${(this.fc.sdFree() / 1048576).toFixed(1)} MB free)`);
    const crc = crc32(gz), n = Math.ceil(gz.length / CHUNK);
    const chunk = (i) => { const c = gz.subarray(i * CHUNK, (i + 1) * CHUNK); return `UD${i.toString(16)}:${hx(crc32(c))}:${b64(c)}`; };
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const st = this.busy = { name, acked: 0, next: 0, resent: 0, started: false, ended: false, last: performance.now() };
      const report = () => { const s = (performance.now() - t0) / 1000; onProgress({ sent: Math.min(gz.length, st.acked * CHUNK), total: gz.length, raw: bytes.length, rate: st.acked * CHUNK / Math.max(s, 0.001), resent: st.resent, seconds: s }); };
      const pump = () => { while (st.started && st.next < n && st.next < st.acked + WINDOW) this.fc.radio(chunk(st.next++)); if (st.acked === n && !st.ended) { st.ended = true; this.fc.radio("UE"); } };
      st.fail = (why) => { clearInterval(st.timer); this.busy = null; reject(new Error(why)); };
      st.reply = async (line) => {
        st.last = performance.now();
        if (line.startsWith("UK")) {
          const k = parseInt(line.slice(2), 16);
          st.started = true; if (k > st.acked) st.acked = k;
          report(); pump();
        } else if (line.startsWith("UN")) {
          // every chunk already in flight behind a bad one is refused too: rewind once per gap
          const k = parseInt(line.slice(2), 16);
          if (k < st.acked || (st.nak === k && performance.now() - st.nakT < 2000)) return;
          st.nak = k; st.nakT = performance.now(); st.resent += st.next - k; st.next = k; pump();
        } else if (line.startsWith("UA")) {
          clearInterval(st.timer); this.busy = null;
          const [nm, verdict, got] = line.slice(2).split(" ");
          if (nm !== name || verdict !== "ok") return reject(new Error(`the satellite rejected ${name} (CRC ${got}, expected ${hx(crc)})`));
          this.local.set(name, bytes);
          await this.fc.syncSd();
          this.fc.log(`UPLINK ${name}: ${(bytes.length / 1024).toFixed(0)} KB (${(gz.length / 1024).toFixed(0)} KB compressed) received, CRC-32 ${hx(crc)} verified, stored at /sd/${name}`);
          report(); resolve({ bytes: bytes.length, gz: gz.length, seconds: (performance.now() - t0) / 1000, resent: st.resent });
        }
      };
      // nothing back for a while: send again from the first unacknowledged chunk
      st.timer = setInterval(() => {
        if (performance.now() - st.last < ACK_TIMEOUT_MS) return;
        if (!this.fc.emu) return st.fail("the satellite is off");
        st.last = performance.now();
        if (!st.started) this.fc.radio(`UB${name} ${gz.length.toString(16)} ${hx(crc)}`);
        else if (st.ended) this.fc.radio("UE");
        else { st.resent += st.next - st.acked; st.next = st.acked; pump(); }
      }, 1000);
      this.fc.radio(`UB${name} ${gz.length.toString(16)} ${hx(crc)}`);
      report();
    });
  }
  onReply(line) {
    if (this.busy) return this.busy.reply(line);
    if (this.deleting && line.startsWith("UA")) { const d = this.deleting; this.deleting = null; d(line); }
  }
  async remove(name) {
    if (this.busy) throw new Error("an upload is running");
    const line = await new Promise((resolve) => { this.deleting = resolve; this.fc.radio("UX" + name); setTimeout(() => { if (this.deleting === resolve) { this.deleting = null; resolve("timeout"); } }, 5000); });
    await this.fc.syncSd();
    if (!/ deleted /.test(line + " ")) throw new Error(`could not delete ${name}`);
    this.fc.log(`UPLINK: /sd/${name} deleted`);
  }

  // ---- running programs ----
  start(cmdline) {
    if (this.run && !this.run.exited) this.fc.radio("GQ");
    const args = splitArgs(cmdline);
    this.run = { cmdline, args, lines: [], exited: null, lock: null, started: performance.now() };
    this.fc.radio("GS" + cmdline);
    this.fc.log(`PAYLOAD: started "${cmdline}"`);
    bus.emit("run", { run: this.run });
    return this.run;
  }
  stop() { if (this.run && !this.run.exited) { this.fc.radio("GQ"); } }
  stdin(text) { if (this.run && !this.run.exited) { this.fc.radio("GI" + text); this.output("> " + text); } }
  output(line) { const r = this.run; if (!r) return; r.lines.push(line); if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 300); bus.emit("run-output", { run: r, line }); }
  onPayload(line) {
    const r = this.run; if (!r) return;
    line = new TextDecoder().decode(Uint8Array.from(line, (c) => c.charCodeAt(0)));   // the serial line carries UTF-8
    if (line.startsWith("@@R")) return this.lockstepStart(r, parseInt(line.slice(3), 16) >>> 0);
    if (line.startsWith("@@D")) { const [t, h] = line.slice(3).split(":"); return this.lockstepFrame(r, parseInt(t, 16), parseInt(h, 16) >>> 0); }
    if (line.startsWith("X")) {
      r.exited = `exited with status ${line.slice(1)}${line.slice(1) === "139" ? " (segmentation fault)" : ""}`;
      this.fc.log(`PAYLOAD: "${r.cmdline}" ${r.exited}`);
      this.fc.syncSd();
      bus.emit("run", { run: r }); return;
    }
    this.output(line);
  }

  // ---- lockstep ----
  async lockstepStart(r, satHash) {
    // no tic goes up until the ground's copy (if any) is ready, so both start counting from the same tic
    const L = r.lock = { ready: false, satReady: satHash, satTic: -1, groundHash: new Map(), twin: null, twinNote: "", diverged: null, tic: 0 };
    // a ground copy: the same program, and the ground's copy of every file named on the command line
    const make = this.twins.get(r.args[0]);
    const files = new Map(r.args.filter((a) => this.local.has(a)).map((a) => [a, this.local.get(a)]));
    const missing = r.args.slice(1).filter((a) => this.has(a) && !this.local.has(a));
    if (!make) L.twinNote = `the ground has no copy of ${r.args[0]}: frames are not checked`;
    else if (missing.length) L.twinNote = `the ground has no copy of ${missing.join(", ")}: frames are not checked`;
    else {
      try { L.twin = await make(r.args, files); L.groundHash.set(-1, L.twin.hash); this.check(r, -1, satHash); }
      catch (e) { L.twinNote = "the ground copy failed to start: " + e.message; }
    }
    L.ready = true;
    bus.emit("run", { run: r });
  }
  // one tic: the ground's copy runs it, and its key events go up to the satellite
  lockstepTick(events) {
    const r = this.run, L = r && r.lock; if (!L || !L.ready) return null;
    const tic = L.tic++;
    if (L.twin) L.groundHash.set(tic, L.twin.tick(events));
    if (!r.exited) this.fc.radio(`GIG${tic.toString(16)}:` + events.map(([dn, k]) => dn.toString(16).padStart(2, "0") + k.toString(16).padStart(2, "0")).join(""));
    return tic;
  }
  lockstepFrame(r, tic, h) { if (!r.lock) return; r.lock.satTic = tic; this.check(r, tic, h); bus.emit("run", { run: r }); }
  check(r, tic, h) {
    const L = r.lock, g = L.groundHash.get(tic);
    if (g !== undefined && g !== h && !L.diverged) {
      L.diverged = { tic, ground: g, sat: h };
      this.fc.log(`PAYLOAD: the satellite's frame differs from the ground's at tic ${tic} (${hx(h)} vs ${hx(g)}): what the satellite computed has been changed`);
    }
    L.groundHash.delete(tic - 400);
  }
}

// Doom: the ground's copy is the same doomgeneric source built for WebAssembly
export function doomTwin(wasmBytes) {
  return (args, files) => GroundDoom.create(wasmBytes, args.map((a, i) => (i === 0 ? "doom" : a)), files);
}
