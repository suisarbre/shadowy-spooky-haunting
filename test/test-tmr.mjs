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


const FI = 0x18C0, CALC = 0x18C1, CALC_HK = 0x08C1;
const flipTmr = (copy, offset, mask) => cmdPacket(FI, 7, Buffer.concat([str("CALC", 20), u8(copy), u8(mask), u16(0), u32(offset)]));
const setTmr = (on) => cmdPacket(CALC, 2, Buffer.from([on ? 1 : 0, 0, 0, 0]));
const calcReset = () => cmdPacket(CALC, 1);
const expected = (step) => Number((BigInt(step) * BigInt(step + 1) / 2n) & 0xffffffffn);
const calc = (m) => ({ step: m.bytes.readUInt32LE(16), sum: m.bytes.readUInt32LE(20),
  copies: [0, 1, 2].map((k) => m.bytes.readUInt32LE(24 + 4 * k)), repairs: m.bytes.readUInt32LE(48), on: m.bytes[64], mask: m.bytes[65] });
const lastCalc = () => { const m = [...tlm].reverse().find((x) => x.mid === CALC_HK); return m ? calc(m) : null; };
const ok = (c) => c && c.sum === expected(c.step);
async function startCfs(log) {
  await sh(`cd /cfs/cpu1 && (./core-cpu1 > ${log} 2>&1 &) ; cd /`);
  for (let i = 0; i < 60; i++) { if (/^[1-9]/.test(await sh(`grep -c 'OPERATIONAL' ${log}`))) return true; await sleep(1000); }
  return false;
}

(async () => {
  try {
    await waitFor(/VM-READY/, 120000);
    record("cFS boots with TMR_LIB and TMR_CALC", await startCfs("/tmp/cfs.log"));
    const lib = await sh("grep -E 'TMR_LIB|TMR_CALC' /tmp/cfs.log | head -3");
    record("TMR_LIB loaded, TMR_CALC initialized", /TMR_LIB initialized/.test(lib) && /TMR_CALC initialized/.test(lib), lib.split("\n").map((l) => l.replace(/^.*?(TMR_)/, "$1")).join(" | "));
    send(cmdPacket(0x1880, 6, str("127.0.0.1", 16))); await sleep(5000);
    let c = lastCalc();
    const allOk = tlm.filter((m) => m.mid === CALC_HK).map(calc).every(ok);
    record("Calculator correct: sum = step(step+1)/2", c && allOk, c ? `step ${c.step}, sum ${c.sum}, copies ${c.copies}, TMR ${c.on ? "on" : "off"}` : "no telemetry");

    // 1) one copy hit: outvoted and repaired at the next calculation
    let t = Date.now(); send(flipTmr(1, 4, 0x10));
    const e1 = await waitEvent(/TMR hit CALC/, t).catch((e) => e.message);
    const r1 = await waitEvent(/outvoted copy 2/, t).catch((e) => e.message);
    await sleep(2500); c = lastCalc();
    record("Hit copy 2: outvoted and repaired, answer stays right", ok(c) && c.repairs === 1 && c.copies.every((v) => v === c.sum), `${e1} || ${r1} || step ${c.step} sum ${c.sum} repairs ${c.repairs}`);

    // 2) a hit on the Step field of copy 3
    t = Date.now(); send(flipTmr(2, 0, 0x01));
    const r2 = await waitEvent(/outvoted copy 3/, t).catch((e) => e.message);
    await sleep(2500); c = lastCalc();
    record("Hit copy 3's step counter: repaired too", ok(c) && c.repairs === 2, r2);

    // 3) the limit: the same bit in two copies before they are voted -> wrong majority wins
    t = Date.now(); send(flipTmr(0, 4, 0x20)); send(flipTmr(1, 4, 0x20));
    await waitEvent(/outvoted copy 3/, t).catch(() => {});
    await sleep(3000); c = lastCalc();
    record("Same bit in 2 copies: majority is wrong, TMR repairs the good copy to the bad value", !ok(c) && c.copies.every((v) => v === c.sum), `step ${c.step}: sum ${c.sum}, should be ${expected(c.step)} (off by ${(c.sum - expected(c.step)) >>> 0})`);
    await sleep(3000); const c2 = lastCalc();
    record("...and it stays wrong (accumulated error)", !ok(c2), `step ${c2.step}: sum ${c2.sum}, should be ${expected(c2.step)}`);

    // reset
    t = Date.now(); send(calcReset()); await waitEvent(/calculator reset/, t).catch(() => {}); await sleep(2500);
    c = lastCalc(); record("Reset brings the calculator back", ok(c), `step ${c.step} sum ${c.sum}`);

    // 4) TMR off: the same single hit is permanent
    t = Date.now(); send(setTmr(false)); await waitEvent(/software TMR OFF/, t).catch(() => {}); await sleep(1500);
    t = Date.now(); send(flipTmr(1, 4, 0x10)); await sleep(2500);
    c = lastCalc(); record("TMR off: hit on copy 2 has no effect (copy 2 unused)", ok(c), `step ${c.step} sum ${c.sum}`);
    t = Date.now(); send(flipTmr(0, 4, 0x10)); await sleep(2500);
    c = lastCalc(); await sleep(3000); const c3 = lastCalc();
    record("TMR off: hit on copy 1 corrupts the answer for good", !ok(c) && !ok(c3) && c.on === 0, `step ${c3.step}: sum ${c3.sum}, should be ${expected(c3.step)}`);

    // 5) TMR back on cannot undo past damage (it re-seeds from copy 1)
    t = Date.now(); send(setTmr(true)); await waitEvent(/software TMR ON/, t).catch(() => {}); await sleep(2500);
    c = lastCalc(); record("TMR back on: copies agree again, but the old error stays", c.on === 1 && !ok(c) && c.copies.every((v) => v === c.sum), `sum ${c.sum}, should be ${expected(c.step)}`);

    const alive = await sh("pidof core-cpu1 || echo dead");
    record("Flight software never restarted", alive !== "dead" && /^[0-9]+$/.test(alive), `pid ${alive}`);
  } catch (e) {
    record("Harness", false, e.message); console.log(con.slice(-2000));
  } finally {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    emu.stop(); setTimeout(() => process.exit(0), 500);
  }
})();
