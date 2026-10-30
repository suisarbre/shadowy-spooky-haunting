// Headless test of FAULT_INJ inside the v86 VM.
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

const emu = new V86({
  wasm_path: path.join(W, "../node_modules/v86/build/v86.wasm"),
  bios: buf(path.join(W, "../docs/bios.bin")), vga_bios: buf(path.join(W, "../docs/vgabios.bin")),
  bzimage: buf(path.join(W, "../docs/bzImage")), initrd: buf(path.join(W, "../docs/initrd.gz")),
  cmdline: "console=ttyS0 rdinit=/init quiet loglevel=3", memory_size: 128 * 1024 * 1024,
  uart1: true, autostart: true, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});

let con = "";
emu.add_listener("serial0-output-byte", (b) => { con += String.fromCharCode(b); });
const waitFor = (re, ms) => new Promise((res, rej) => { const end = Date.now() + ms; const iv = setInterval(() => { const m = con.match(re); if (m) { clearInterval(iv); res(m); } else if (Date.now() > end) { clearInterval(iv); rej(new Error("timeout " + re)); } }, 100); });
let seq = 0;
async function sh(cmd, ms = 60000) { const id = ++seq; emu.serial0_send(`echo @@B${id}; ${cmd}; echo @@E${id}\n`); const m = await waitFor(new RegExp(`@@B${id}\\r?\\n([\\s\\S]*?)@@E${id}`), ms); return m[1].replace(/\r/g, "").trim(); }

let s1 = ""; const tlm = [];
emu.add_listener("serial1-output-byte", (b) => { const c = String.fromCharCode(b); if (c === "\n") { if (s1[0] === "T") { const bytes = Buffer.from(s1.slice(1), "hex"); tlm.push({ t: Date.now(), mid: bytes.readUInt16BE(0), bytes }); } s1 = ""; } else s1 += c; });

function cmdPacket(mid, fc, payload = Buffer.alloc(0)) { const p = Buffer.alloc(8 + payload.length); p.writeUInt16BE(mid, 0); p.writeUInt16BE(0xc000, 2); p.writeUInt16BE(p.length - 7, 4); p[6] = fc; payload.copy(p, 8); let x = 0xff; for (const b of p) x ^= b; p[7] = x; return p; }
const str = (s, n) => { const b = Buffer.alloc(n); b.write(s, "ascii"); return b; };
const u8 = (v) => Buffer.from([v & 255]); const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }; const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const send = (pkt) => emu.serial_send_bytes(1, Buffer.from("C" + pkt.toString("hex") + "\n", "ascii"));
const evText = (m) => { const c = (o, n) => { let t = ""; for (let i = o; i < o + n && m.bytes[i]; i++) t += String.fromCharCode(m.bytes[i]); return t; }; return `[${c(16, 20)}] ${c(48, 122)}`; };
const waitEvent = (re, since, ms = 20000) => new Promise((res, rej) => { const end = Date.now() + ms; const iv = setInterval(() => { const m = tlm.find((x) => x.mid === 0x0808 && x.t >= since && re.test(evText(x))); if (m) { clearInterval(iv); res(evText(m)); } else if (Date.now() > end) { clearInterval(iv); rej(new Error("no event " + re)); } }, 100); });
const latest = (mid, since) => [...tlm].reverse().find((x) => x.mid === mid && x.t >= since);

const FI = 0x18C0, FI_HK = 0x08C0, SAMPLE_HK = 0x0883;
const REG = { code: 0, rodata: 1, data: 2, bss: 3 };
const query = (app) => cmdPacket(FI, 2, str(app, 20));
const flip = (app, region, offset, mask) => cmdPacket(FI, 3, Buffer.concat([str(app, 20), u8(REG[region]), u8(mask), u16(0), u32(offset)]));
const flipRandom = (app, region, count, seed) => cmdPacket(FI, 4, Buffer.concat([str(app, 20), u8(REG[region]), u8(0), u16(count), u32(seed)]));
const flipSym = (app, sym, offset, mask) => cmdPacket(FI, 5, Buffer.concat([str(app, 20), str(sym, 32), u32(offset), u8(mask), Buffer.alloc(3)]));

async function startCfs(log) {
  await sh(`cd /cfs/cpu1 && (./core-cpu1 > ${log} 2>&1 &) ; cd /`);
  for (let i = 0; i < 60; i++) { if (/^[1-9]/.test(await sh(`grep -c 'OPERATIONAL' ${log}`))) return true; await sleep(1000); }
  return false;
}

(async () => {
  try {
    await waitFor(/VM-READY/, 120000);
    record("cFS boots with FAULT_INJ", await startCfs("/tmp/cfs.log"));
    const init = await sh("grep -E 'FAULT_INJ' /tmp/cfs.log | tail -2");
    record("FAULT_INJ app loaded and initialized", /initialized/.test(init), init.split("\n").pop());
    send(cmdPacket(0x1880, 6, str("127.0.0.1", 16))); await sleep(2500);

    let t = Date.now(); send(cmdPacket(FI, 0));
    try { record("NOOP -> event", true, await waitEvent(/FAULT_INJ ready/, t)); } catch (e) { record("NOOP -> event", false, e.message); }
    await sleep(1500);
    const hk = latest(FI_HK, t); record("FAULT_INJ housekeeping telemetry", !!hk, hk ? `CmdCounter=${hk.bytes[16]}` : "none");

    t = Date.now(); send(query("SAMPLE_APP"));
    try { record("QUERY SAMPLE_APP memory map", true, await waitEvent(/SAMPLE_APP code=/, t)); } catch (e) { record("QUERY SAMPLE_APP memory map", false, e.message); }
    t = Date.now(); send(query("CORE"));
    try { record("QUERY CORE (cFS executive) memory map", true, await waitEvent(/CORE code=/, t)); } catch (e) { record("QUERY CORE", false, e.message); }

    // Visible upset: flip bit 7 of SAMPLE_APP's command counter (offset 0 of SAMPLE_APP_Data) and watch its telemetry
    t = Date.now(); await sleep(6000);
    const before = latest(SAMPLE_HK, t - 6000);
    const cBefore = before ? before.bytes[16] : -1;
    t = Date.now(); send(flipSym("SAMPLE_APP", "SAMPLE_APP_Data", 0, 0x80));
    let ev = ""; try { ev = await waitEvent(/SYMBOL hit SAMPLE_APP/, t); } catch (e) { ev = e.message; }
    await sleep(7000);
    const after = latest(SAMPLE_HK, t);
    const cAfter = after ? after.bytes[16] : -1;
    record("Bit flip shows up in victim's telemetry", cBefore >= 0 && cAfter === (cBefore ^ 0x80), `SAMPLE_APP CmdCounter ${cBefore} -> ${cAfter}; ${ev}`);

    // Reproducibility: same target twice flips the same address back
    t = Date.now(); send(flip("SAMPLE_APP", "bss", 0x40, 0x01));
    const e1 = await waitEvent(/FLIP hit SAMPLE_APP bss/, t).catch((e) => e.message);
    t = Date.now(); send(flip("SAMPLE_APP", "bss", 0x40, 0x01));
    const e2 = await waitEvent(/FLIP hit SAMPLE_APP bss/, t).catch((e) => e.message);
    const a1 = (e1.match(/@([0-9a-f]+)/) || [])[1], a2 = (e2.match(/@([0-9a-f]+)/) || [])[1];
    const v1 = (e1.match(/: (..)->(..)/) || []), v2 = (e2.match(/: (..)->(..)/) || []);
    record("Same target -> same address (reproducible)", a1 && a1 === a2 && v1[2] === v2[1] && v2[2] === v1[1], `${e1} | ${e2}`);

    // Random upsets in data: system should survive
    t = Date.now(); send(flipRandom("SAMPLE_APP", "data", 8, 1234));
    const er = await waitEvent(/RANDOM hit SAMPLE_APP data/, t).catch((e) => e.message);
    await sleep(4000);
    const alive = await sh("pidof core-cpu1 || echo dead");
    record("8 random data upsets, flight software survives", alive !== "dead", er);

    // Code upsets: corrupt SAMPLE_APP's executable code, then make it run (send it a NOOP)
    t = Date.now(); send(flipRandom("SAMPLE_APP", "code", 40, 777));
    const ec = await waitEvent(/RANDOM hit SAMPLE_APP code/, t).catch((e) => e.message);
    for (let i = 0; i < 5; i++) { send(cmdPacket(0x1882, 0)); await sleep(1500); }
    await sleep(5000);
    const st = await sh("pidof core-cpu1 || echo dead; tail -n 6 /tmp/cfs.log");
    const died = st.startsWith("dead");
    const tail = st.split("\n").slice(1).join(" | ");
    console.log("---- after code corruption ----\n" + st + "\n-------------------------------");
    record("40 code upsets in SAMPLE_APP observed", true, died ? "flight software process crashed (complete failure)" : "still running: " + tail.slice(0, 200));

    if (died) {
      const ok = await startCfs("/tmp/cfs2.log");
      const rt = await sh("grep -oE 'PROCESSOR RESET|POWERON RESET|Reset Type[^\\n]*' /tmp/cfs2.log | head -1");
      record("Watchdog-style restart after crash", ok, rt);
    }

    console.log("\n---- events ----\n" + tlm.filter((m) => m.mid === 0x0808).map(evText).filter((s) => /FAULT_INJ|SAMPLE_APP|CFE_ES/.test(s)).slice(-14).join("\n"));
  } catch (e) {
    record("Harness", false, e.message); console.log(con.slice(-2000));
  } finally {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    emu.stop(); setTimeout(() => process.exit(0), 500);
  }
})();
