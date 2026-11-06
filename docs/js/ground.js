// The ground station: uplinks software to the satellite and plays its payload application.
//
// Uplink: a file goes up gzip-compressed in base64 chunks with a CRC-32 each, over the same radio
// link as commands (build/serbridge.c has the other side). The satellite acknowledges each chunk in
// order; a bad or missing chunk is resent (go-back-N, a window of chunks in flight). When the whole
// file checks out, the flight software stores it, and the model writes it to the SD card so it
// survives a reboot.
//
// Payload: Doom runs on the satellite and here at the same time, from the same source and the same
// game data. The ground records the player's keys per tic and uplinks them; the satellite runs the
// same tics and downlinks a hash of each frame. Doom is deterministic, so every hash must match the
// ground's; the first one that does not is where radiation changed what the satellite computed.
import { bus } from "./util.js";
import { GroundDoom } from "./doom-ground.js";

const CHUNK = 2048, WINDOW = 8, ACK_TIMEOUT_MS = 6000;
export const LINK_BPS = 9600;   // a typical CubeSat UHF uplink, for comparison

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export function crc32(bytes, c = 0) { c = ~c >>> 0; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
const hx = (n) => (n >>> 0).toString(16).padStart(8, "0");
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
export async function gzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()); }

export class GroundStation {
  constructor({ fc }) {
    this.fc = fc; this.busy = null; this.doom = null;
    bus.on("uplink-reply", (e) => this.onReply(e.line));
    bus.on("payload", (e) => this.onPayload(e.line));
    bus.on("power-on", () => { if (this.busy) this.busy.fail("the satellite rebooted during the upload"); if (this.doom) this.doomLost("the satellite rebooted"); });
  }
  // files the ground has put on the satellite's SD card
  payloadFiles() { return this.fc.sdFiles.filter((f) => f.name.startsWith("payload/")).map((f) => ({ name: f.name.slice(8).replace(/\.gz$/, ""), size: f.size })); }
  hasPayload(name) { return this.payloadFiles().some((f) => f.name === name); }

  // ---- uplink ----
  // returns a promise; onProgress({ sent, total, rate, phase })
  async uplink(name, bytes, { onProgress = () => {} } = {}) {
    if (this.busy) throw new Error("an upload is already running");
    if (!this.fc.emu) throw new Error("the satellite is off");
    const gz = await gzip(bytes), file = name + ".gz", crc = crc32(gz), n = Math.ceil(gz.length / CHUNK);
    if (gz.length + 1024 > this.fc.sdFree()) throw new Error(`not enough room on the SD card (${(gz.length / 1048576).toFixed(1)} MB needed, ${(this.fc.sdFree() / 1048576).toFixed(1)} MB free)`);
    const chunk = (i) => { const c = gz.subarray(i * CHUNK, (i + 1) * CHUNK); return `UD${i.toString(16)}:${hx(crc32(c))}:${b64(c)}`; };
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const st = this.busy = { name: file, acked: 0, next: 0, resent: 0, started: false, done: false, last: performance.now() };
      const report = (phase) => { const s = (performance.now() - t0) / 1000; onProgress({ phase, sent: Math.min(gz.length, st.acked * CHUNK), total: gz.length, raw: bytes.length, rate: st.acked * CHUNK / Math.max(s, 0.001), resent: st.resent, seconds: s }); };
      const pump = () => { while (st.started && st.next < n && st.next < st.acked + WINDOW) this.fc.radio(chunk(st.next++)); if (st.acked === n && !st.ended) { st.ended = true; this.fc.radio("UE"); } };
      st.fail = (why) => { clearInterval(st.timer); this.busy = null; reject(new Error(why)); };
      st.reply = (line) => {
        st.last = performance.now();
        if (line.startsWith("UK")) {
          const k = parseInt(line.slice(2), 16);
          if (!st.started) st.started = true;
          if (k > st.acked) st.acked = k;
          report("sending"); pump();
        } else if (line.startsWith("UN")) {
          // every chunk already in flight behind a bad one is refused too: rewind once per gap
          const k = parseInt(line.slice(2), 16);
          if (k < st.acked || (st.nak === k && performance.now() - st.nakT < 2000)) return;
          st.nak = k; st.nakT = performance.now(); st.resent += st.next - k; st.next = k; pump();
        } else if (line.startsWith("UA")) {
          clearInterval(st.timer); this.busy = null;
          const [nm, verdict, got] = line.slice(2).split(" ");
          if (nm !== file || verdict !== "ok") return reject(new Error(`the satellite rejected ${file} (CRC ${got}, expected ${hx(crc)})`));
          // the flight software has the verified file: it goes onto the SD card
          if (!this.fc.writeSdFile("payload/" + file, gz)) return reject(new Error("the SD card is full"));
          this.fc.log(`UPLINK ${name}: ${(bytes.length / 1024).toFixed(0)} KB (${(gz.length / 1024).toFixed(0)} KB compressed) received, CRC-32 ${hx(crc)} verified, stored on the SD card`);
          report("done"); resolve({ bytes: bytes.length, gz: gz.length, seconds: (performance.now() - t0) / 1000, resent: st.resent });
        }
      };
      // nothing back for a while: send again from the first unacknowledged chunk
      st.timer = setInterval(() => {
        if (performance.now() - st.last < ACK_TIMEOUT_MS) return;
        if (!this.fc.emu) return st.fail("the satellite is off");
        st.last = performance.now();
        if (!st.started) this.fc.radio(`UB${file} ${gz.length.toString(16)} ${hx(crc)}`);
        else if (st.ended) this.fc.radio("UE");
        else { st.resent += st.next - st.acked; st.next = st.acked; pump(); }
      }, 1000);
      this.fc.log(`UPLINK ${name}: ${(gz.length / 1024).toFixed(0)} KB to send (at ${LINK_BPS / 1000} kbps that is ${Math.ceil(gz.length * 8 * 4 / 3 / LINK_BPS / 60)} min)`);
      this.fc.radio(`UB${file} ${gz.length.toString(16)} ${hx(crc)}`);
      report("starting");
    });
  }
  onReply(line) { if (this.busy) this.busy.reply(line); }

  // ---- payload: Doom in lockstep ----
  // wad: { name, bytes }. Starts the ground copy and asks the satellite to start its copy.
  async startDoom(wasmBytes, wad) {
    this.stopDoom();
    const ground = await GroundDoom.create(wasmBytes, wad);
    const d = this.doom = { ground, wad, sat: new Map(), groundHash: new Map(), satTic: -1, satReady: null, diverged: null, ended: null, log: [] };
    d.groundHash.set(-1, ground.hash);
    this.fc.radio("GS" + wad.name);
    bus.emit("doom", { d });
    return d;
  }
  stopDoom() { if (this.doom) { this.fc.radio("GQ"); this.doom = null; bus.emit("doom", { d: null }); } }
  doomLost(why) { if (this.doom && !this.doom.ended) { this.doom.ended = why; bus.emit("doom", { d: this.doom }); } }
  // one tic on the ground, uplinked to the satellite
  doomTick(events) {
    const d = this.doom; if (!d || !d.satReady) return null;
    const tic = d.ground.tic, h = d.ground.tick(events);
    d.groundHash.set(tic, h);
    if (!d.ended) this.fc.radio(`G${tic.toString(16)}:` + events.map(([dn, k]) => dn.toString(16).padStart(2, "0") + k.toString(16).padStart(2, "0")).join(""));
    return h;
  }
  onPayload(line) {
    const d = this.doom; if (!d) return;
    if (line.startsWith("@@R")) { d.satReady = parseInt(line.slice(3), 16) >>> 0; this.check(d, -1, d.satReady); }
    else if (line.startsWith("@@D")) { const [t, h] = line.slice(3).split(":"); const tic = parseInt(t, 16); d.satTic = tic; this.check(d, tic, parseInt(h, 16) >>> 0); }
    else if (line.startsWith("@@E")) { d.ended = line.slice(4); this.fc.log(`PAYLOAD: ${d.ended}`); }
    else if (line.startsWith("X")) { if (!d.ended) d.ended = `the payload exited (status ${line.slice(1)})`; this.fc.log(`PAYLOAD: ${d.ended}`); }
    else { d.log.push(line); if (d.log.length > 40) d.log.shift(); }
    bus.emit("doom", { d });
  }
  check(d, tic, h) {
    const g = d.groundHash.get(tic);
    d.sat.set(tic, h);
    if (g !== undefined && g !== h && !d.diverged) {
      d.diverged = { tic, ground: g, sat: h };
      this.fc.log(`PAYLOAD: the satellite's frame differs from the ground's at tic ${tic} (${hx(h)} vs ${hx(g)}): the satellite's copy of Doom has been changed`);
    }
    d.groundHash.delete(tic - 400);
  }
}
