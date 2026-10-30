// Headless test: boot the v86 VM, start cFS, and exercise the APIs the sim needs.
// Usage: node test-cfs.js
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

const emu = new V86({
  wasm_path: path.join(W, "../node_modules/v86/build/v86.wasm"),
  bios: buf(path.join(W, "../docs/bios.bin")),
  vga_bios: buf(path.join(W, "../docs/vgabios.bin")),
  bzimage: buf(path.join(W, "../docs/bzImage")),
  initrd: buf(path.join(W, "../docs/initrd.gz")),
  cmdline: "console=ttyS0 rdinit=/init quiet loglevel=3",
  memory_size: 128 * 1024 * 1024,
  uart1: true,
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
  disable_speaker: true,
});

// ---- console (ttyS0) ----
let con = "";
const conLog = fs.createWriteStream(path.join(W, "console.log"));
emu.add_listener("serial0-output-byte", (b) => { const c = String.fromCharCode(b); con += c; conLog.write(c); });
const waitFor = (re, ms) => new Promise((res, rej) => {
  const start = con.length, end = Date.now() + ms;
  const iv = setInterval(() => {
    const m = con.slice(start).match(re) || con.match(re);
    if (m) { clearInterval(iv); res(m); } else if (Date.now() > end) { clearInterval(iv); rej(new Error("timeout waiting for " + re)); }
  }, 100);
});
let seq = 0;
// Run a shell command and return its output, delimited by unique markers.
async function sh(cmd, ms = 60000) {
  const id = ++seq;
  emu.serial0_send(`echo @@B${id}; ${cmd}; echo @@E${id}\n`);
  const m = await waitFor(new RegExp(`@@B${id}\\r?\\n([\\s\\S]*?)@@E${id}`), ms);
  return m[1].replace(/\r/g, "").trim();
}

// ---- data channel (ttyS1): CCSDS packets, hex framed ----
let s1 = "";
const tlm = []; // {t, mid, bytes}
emu.add_listener("serial1-output-byte", (b) => {
  const c = String.fromCharCode(b);
  if (c === "\n") {
    if (s1[0] === "T") {
      const hex = s1.slice(1);
      const bytes = Buffer.from(hex, "hex");
      tlm.push({ t: Date.now(), mid: bytes.readUInt16BE(0), bytes });
    } else if (s1 === "B") bridgeReady = true;
    s1 = "";
  } else s1 += c;
});
let bridgeReady = false;

// Build a CCSDS command: primary header + function code + checksum, payload little-endian.
function cmdPacket(mid, fc, payload = Buffer.alloc(0)) {
  const len = 8 + payload.length;
  const p = Buffer.alloc(len);
  p.writeUInt16BE(mid, 0);
  p.writeUInt16BE(0xc000, 2);
  p.writeUInt16BE(len - 7, 4);
  p[6] = fc; p[7] = 0;
  payload.copy(p, 8);
  let x = 0xff; for (const b of p) x ^= b; p[7] = x; // makes XOR of whole packet 0xFF
  return p;
}
const str = (s, n) => { const b = Buffer.alloc(n); b.write(s, "ascii"); return b; };
const sendCmd = (pkt) => { const line = "C" + pkt.toString("hex") + "\n"; emu.serial_send_bytes(1, Buffer.from(line, "ascii")); };
const events = () => tlm.filter((m) => m.mid === 0x0808).map((m) => m.bytes.toString("latin1").replace(/[^\x20-\x7e]+/g, " "));
const waitTlm = (pred, ms) => new Promise((res, rej) => {
  const end = Date.now() + ms;
  const iv = setInterval(() => { const m = tlm.find(pred); if (m) { clearInterval(iv); res(m); } else if (Date.now() > end) { clearInterval(iv); rej(new Error("telemetry timeout")); } }, 100);
});

const MID = { ES_CMD: 0x1806, TO_CMD: 0x1880, ES_HK: 0x0800, EVS_LONG: 0x0808, TO_HK: 0x0880 };

(async () => {
  try {
    await waitFor(/VM-READY/, 120000);
    record("Linux boots in v86", true, `${((Date.now() - t0) / 1000).toFixed(1)}s to init`);

    const info = await sh("uname -r; grep -m1 'model name' /proc/cpuinfo; grep MemTotal /proc/meminfo; mount | grep -c mqueue");
    record("Kernel + POSIX mqueue fs mounted", /\n1$/.test(info), info.split("\n").join(" | "));

    // Start cFS like a flight computer would: from its install dir, output to a log
    await sh("cd /cfs/cpu1 && (./core-cpu1 > /tmp/cfs.log 2>&1 &) ; cd /");
    const tBoot = Date.now();
    let op = "";
    for (let i = 0; i < 120; i++) {
      op = await sh("grep -c 'OPERATIONAL' /tmp/cfs.log; tail -n 2 /tmp/cfs.log");
      if (/^[1-9]/.test(op)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    record("cFS reaches OPERATIONAL", /^[1-9]/.test(op), `${((Date.now() - tBoot) / 1000).toFixed(1)}s after launch`);

    const log = await sh("cat /tmp/cfs.log | grep -iE 'error|fail|warn' | grep -v 'NOTE' | head -20");
    console.log("---- cFS log warnings/errors ----\n" + (log || "(none)") + "\n---------------------------------");
    const apps = await sh("grep -oE 'Loading (shared library|file): [^ ]+' /tmp/cfs.log | sort | uniq; grep -c 'Started' /tmp/cfs.log");
    record("App modules loaded via dlopen", /\.so/.test(apps), apps.split("\n").map((l) => l.split("/").pop()).join(", "));

    const tasks = await sh("ls /proc/$(pidof core-cpu1)/task | wc -l; ls -l /proc/$(pidof core-cpu1)/fd | grep -c deleted; grep VmRSS /proc/$(pidof core-cpu1)/status");
    const [nThreads, nQueues] = tasks.split("\n");
    record("Threads + message queues created", +nThreads > 5 && +nQueues > 5, `${nThreads} threads, ${nQueues} open POSIX message queues, ${tasks.split("\n")[2]}`);

    // UDP + bridge: tell TO_LAB to send telemetry to localhost, where serbridge listens
    record("Serial bridge ready", bridgeReady, "ttyS1 <-> UDP cmd 1234 / tlm 2234");
    sendCmd(cmdPacket(MID.TO_CMD, 6, str("127.0.0.1", 16)));
    try {
      await waitTlm((m) => m.mid === MID.ES_HK, 30000);
      const mids = [...new Set(tlm.map((m) => m.mid.toString(16).padStart(4, "0")))];
      record("Telemetry flows cFS -> UDP -> serial -> JS", true, `MIDs seen: ${mids.join(" ")}`);
    } catch (e) { record("Telemetry flows cFS -> UDP -> serial -> JS", false, e.message); }

    // Command path: ES NOOP should produce an event message
    sendCmd(cmdPacket(MID.ES_CMD, 0));
    try { await waitTlm((m) => m.mid === MID.EVS_LONG && /No-op/i.test(m.bytes.toString("latin1")), 20000); record("Commands reach cFS (ES NOOP -> event)", true); }
    catch (e) { record("Commands reach cFS (ES NOOP -> event)", false, e.message); }

    // Telemetry timing: ES HK rate over 20 s of wall clock
    const hk0 = tlm.filter((m) => m.mid === MID.ES_HK).length; const w0 = Date.now();
    await new Promise((r) => setTimeout(r, 20000));
    const hkN = tlm.filter((m) => m.mid === MID.ES_HK).length - hk0; const wN = (Date.now() - w0) / 1000;
    record("Scheduler/timers keep cadence", hkN > 0, `${hkN} ES HK packets in ${wN.toFixed(1)}s wall clock (${(hkN / wN).toFixed(2)}/s)`);

    // Fault recovery primitive: restart an app in place
    sendCmd(cmdPacket(MID.ES_CMD, 6, str("SAMPLE_APP", 20)));
    try { await waitTlm((m) => m.mid === MID.EVS_LONG && /Restart Application SAMPLE_APP Success/i.test(m.bytes.toString("latin1").replace(/[^\x20-\x7e]+/g," ")) && m.t > w0, 30000); record("ES Restart App (H&S-style recovery)", true); }
    catch (e) { record("ES Restart App (H&S-style recovery)", false, e.message); }

    // Update primitive: reload an app from a (new) file
    const so = (await sh("ls /cfs/cpu1/cf/ | grep -i sample_app | head -1"));
    await sh(`cp /cfs/cpu1/cf/${so} /cfs/cpu1/cf/sample_app_v2.so`);
    const tR = Date.now();
    sendCmd(cmdPacket(MID.ES_CMD, 7, Buffer.concat([str("SAMPLE_APP", 20), str("/cf/sample_app_v2.so", 64)])));
    try { await waitTlm((m) => m.mid === MID.EVS_LONG && /Reload Application SAMPLE_APP (Completed|Success)/i.test(m.bytes.toString("latin1").replace(/[^\x20-\x7e]+/g," ")) && m.t > tR, 30000); record("ES Reload App from new file (OTA-style update)", true, `from /cf/sample_app_v2.so`); }
    catch (e) { record("ES Reload App from new file (OTA-style update)", false, e.message); }

    // Hard crash + supervisor restart: kill the flight software process and boot it again
    await sh("kill -9 $(pidof core-cpu1)");
    const gone = await sh("pidof core-cpu1 || echo dead");
    await sh("cd /cfs/cpu1 && (./core-cpu1 > /tmp/cfs2.log 2>&1 &) ; cd /");
    const tRe = Date.now(); let op2 = "";
    for (let i = 0; i < 120; i++) { op2 = await sh("grep -c 'OPERATIONAL' /tmp/cfs2.log; grep -oE '(POWERON|PROCESSOR)[A-Z_ ]*RESET|Reset Type[^\\n]*' /tmp/cfs2.log | head -2"); if (/^[1-9]/.test(op2)) break; await new Promise((r) => setTimeout(r, 1000)); }
    record("Kill -9 + cold restart (watchdog-style)", gone === "dead" && /^[1-9]/.test(op2), `back to OPERATIONAL in ${((Date.now() - tRe) / 1000).toFixed(1)}s; ${op2.split("\n").slice(1).join(" ")}`);

    // Memory poke primitive for fault injection: does /proc/<pid>/mem write work here?
    const poke = await sh("ls /cfs/cpu1/cf | head -40 | tr '\\n' ' '");
    console.log("cf dir:", poke);

    console.log("\n---- recent events ----\n" + events().slice(-12).join("\n"));
  } catch (e) {
    record("Harness", false, e.message);
    console.log("---- console tail ----\n" + con.slice(-3000));
  } finally {
    fs.writeFileSync(path.join(W, "results.json"), JSON.stringify(results, null, 2));
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    emu.stop(); setTimeout(() => process.exit(0), 500);
  }
})();
