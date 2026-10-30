// Headless test of the hardware watchdog loop: cFS (Health & Safety) kicks a
// simulated watchdog chip over ttyS2; if kicks stop, the chip reboots the VM.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { V86 } from "v86";

const W = path.dirname(fileURLToPath(import.meta.url));
const buf = (p) => { const b = fs.readFileSync(p); return { buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ts()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = {
  bios: buf(path.join(W, "../docs/bios.bin")), vga_bios: buf(path.join(W, "../docs/vgabios.bin")),
  bzimage: buf(path.join(W, "../docs/bzImage")), initrd: buf(path.join(W, "../docs/initrd.gz")),
};
let emu;
function powerOn() {
  emu = new V86({
    wasm_path: path.join(W, "../node_modules/v86/build/v86.wasm"), ...files,
    cmdline: "console=ttyS0 rdinit=/init quiet loglevel=3 fsw=auto", memory_size: 72 * 1024 * 1024,
    uart1: true, uart2: true, autostart: true, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
  });
  emu.add_listener("serial0-output-byte", (b) => { con += String.fromCharCode(b); });
  emu.add_listener("serial2-output-byte", onWatchdogByte);
  emu.add_listener("serial1-output-byte", (b) => { const c = String.fromCharCode(b); if (c === "\n") s1 = ""; else s1 += c; });
}
// A hardware watchdog reset cuts power: throw away the whole emulated computer and boot a new one.
async function powerCycle() { const old = emu; emu = null; try { await old.destroy(); } catch (e) {} powerOn(); }


let con = "";
const waitFor = (re, ms, from = 0) => new Promise((res, rej) => { const end = Date.now() + ms; const iv = setInterval(() => { const m = con.slice(from).match(re); if (m) { clearInterval(iv); res(m); } else if (Date.now() > end) { clearInterval(iv); rej(new Error("timeout " + re)); } }, 100); });
let seq = 0;
async function sh(cmd, ms = 30000) { const id = ++seq; const from = con.length; emu.serial0_send(`echo @@B${id}; ${cmd}; echo @@E${id}\n`); const m = await waitFor(new RegExp(`@@B${id}\\r?\\n([\\s\\S]*?)@@E${id}`), ms, from); return m[1].replace(/\r/g, "").trim(); }

// ---- the watchdog chip (what the demo page will implement) ----
const wd = { enabled: false, timeoutMs: 0, lastKick: 0, kicks: 0, resets: 0, lines: [] };
let s2 = "";
function onWatchdogByte(b) {
  const c = String.fromCharCode(b);
  if (c !== "\n") { s2 += c; return; }
  const line = s2.trim(); s2 = "";
  wd.lines.push(line);
  if (line === "WE") { wd.enabled = true; wd.lastKick = Date.now(); }
  else if (line === "WD") wd.enabled = false;
  else if (line.startsWith("WS")) wd.timeoutMs = parseInt(line.slice(2), 10);
  else if (line === "WK") { wd.lastKick = Date.now(); wd.kicks++; }
}
let onReset = null;
setInterval(() => {
  if (wd.enabled && wd.timeoutMs && Date.now() - wd.lastKick > wd.timeoutMs) {
    wd.enabled = false; wd.resets++;
    console.log(`${ts()} WATCHDOG EXPIRED after ${((Date.now() - wd.lastKick) / 1000).toFixed(1)}s without a kick -> hardware reset`);
    con = ""; s2 = ""; powerCycle(); if (onReset) onReset();
  }
}, 200);


function cmdPacket(mid, fc, payload = Buffer.alloc(0)) { const p = Buffer.alloc(8 + payload.length); p.writeUInt16BE(mid, 0); p.writeUInt16BE(0xc000, 2); p.writeUInt16BE(p.length - 7, 4); p[6] = fc; payload.copy(p, 8); let x = 0xff; for (const b of p) x ^= b; p[7] = x; return p; }
const str = (s, n) => { const b = Buffer.alloc(n); b.write(s, "ascii"); return b; };
const send = (pkt) => emu.serial_send_bytes(1, Buffer.from("C" + pkt.toString("hex") + "\n", "ascii"));
const flipRandom = (app, region, count, seed) => { const p = Buffer.alloc(28); str(app, 20).copy(p); p[20] = region; p.writeUInt16LE(count, 22); p.writeUInt32LE(seed, 24); return cmdPacket(0x18c0, 4, p); };

async function waitOperational(label) {
  const tb = Date.now();
  await waitFor(/VM-READY/, 120000);
  await waitFor(/FSW-AUTOSTART/, 30000);
  await waitFor(/entering OPERATIONAL/, 60000);
  return ((Date.now() - tb) / 1000).toFixed(1);
}

let s1 = "";
(async () => {
  powerOn();
  try {
    const bootS = await waitOperational();
    record("Boots straight into flight software (fsw=auto)", true, `OPERATIONAL ${bootS}s after power-on`);
    await sleep(6000);
    record("Health & Safety arms the watchdog over ttyS2", wd.enabled && wd.timeoutMs > 0, `timeout ${wd.timeoutMs} ms; first lines: ${wd.lines.slice(0, 4).join(" ")}`);
    const k0 = wd.kicks; await sleep(10000);
    const rate = (wd.kicks - k0) / 10;
    record("Watchdog kicked regularly while healthy", rate >= 0.5, `${rate.toFixed(1)} kicks/s, ${wd.resets} resets`);

    // Scenario 1: radiation crashes the flight software -> no kicks -> reset -> back up on its own
    let reset1 = 0; onReset = () => { reset1 = Date.now(); };
    send(cmdPacket(0x1880, 6, str("127.0.0.1", 16))); await sleep(1500);
    const tHit = Date.now();
    send(flipRandom("SAMPLE_APP", 0, 40, 777));
    for (let i = 0; i < 5; i++) { send(cmdPacket(0x1882, 0)); await sleep(1200); }
    for (let i = 0; i < 60 && !reset1; i++) await sleep(500);
    record("Crash from code hits -> watchdog resets the computer", !!reset1, reset1 ? `reset ${((reset1 - tHit) / 1000).toFixed(1)}s after the hits` : "no reset");
    if (reset1) {
      const back = await waitOperational();
      await sleep(5000);
      record("Flight software back with no human action", wd.enabled && wd.resets === 1, `OPERATIONAL ${back}s after reset; ${((Date.now() - tHit) / 1000).toFixed(0)}s total outage+settle; watchdog re-armed: ${wd.enabled}`);
      const rt = await sh("grep -oE '(POWER ?ON|PROCESSOR)[ A-Z]*RESET' /tmp/cfs.log | head -1");
      record("cFS sees the hardware reset as a power-on reset", /POWER/.test(rt), rt || "(not found)");
    }

    // Scenario 2: flight software hangs (process alive but frozen) -> also caught
    let reset2 = 0; onReset = () => { reset2 = Date.now(); };
    await sh("kill -STOP $(pidof core-cpu1)");
    const tHang = Date.now();
    for (let i = 0; i < 60 && !reset2; i++) await sleep(500);
    record("Hang (frozen process) -> watchdog resets the computer", !!reset2, reset2 ? `reset ${((reset2 - tHang) / 1000).toFixed(1)}s after freezing` : "no reset");
    if (reset2) { const back = await waitOperational(); record("Back after hang reset", true, `OPERATIONAL ${back}s after reset`); }

    // Scenario 3: watchdog disarmed (protection off): crash is permanent
    onReset = null;
    wd.enabled = false; const resetsBefore = wd.resets;
    const disarm = setInterval(() => { wd.enabled = false; }, 50); // chip jumper pulled
    await sh("kill -9 $(pidof core-cpu1)");
    await sleep(15000);
    clearInterval(disarm);
    const alive = await sh("pidof core-cpu1 || echo dead");
    record("Without the watchdog, a crash stays down", alive === "dead" && wd.resets === resetsBefore, `after 15s: ${alive}`);
  } catch (e) {
    record("Harness", false, e.message); console.log(con.slice(-1500));
  } finally {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (emu) emu.stop(); setTimeout(() => process.exit(0), 500);
  }
})();
