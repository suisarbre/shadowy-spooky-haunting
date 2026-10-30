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
  cmdline: "console=ttyS0 rdinit=/init quiet loglevel=3", memory_size: 72 * 1024 * 1024,
  uart1: true, uart3: true, autostart: true, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
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


// diagnostic port (ttyS3): physical memory map
let s3 = "", mapLines = null, mapBuf = [];
emu.add_listener("serial3-output-byte", (b) => { const c = String.fromCharCode(b); if (c !== "\n") { s3 += c; return; }
  const l = s3; s3 = ""; if (l === "MB") mapBuf = []; else if (l.startsWith("ME")) { mapLines = mapBuf; mapLines.total = l; } else mapBuf.push(l); });
async function getMap() { mapLines = null; const t = Date.now(); emu.serial_send_bytes(3, Buffer.from("M\n")); for (let i = 0; i < 300 && !mapLines; i++) await sleep(100); return { lines: mapLines, ms: Date.now() - t }; }
const parse = (lines) => lines.filter((l) => l[0] === "R").map((l) => { const [, pfn, n, va, pid, comm, label] = l.split(" "); return { pfn: parseInt(pfn, 16), n: parseInt(n, 16), va: parseInt(va, 16), pid: parseInt(pid, 16), comm, label }; });
const kernel = (lines) => lines.filter((l) => l[0] === "K").map((l) => { const [, pfn, n, label] = l.split(" "); return { pfn: parseInt(pfn, 16), n: parseInt(n, 16), label }; });
const physOf = (runs, va, comm = "core-cpu1") => { const r = runs.find((x) => x.comm === comm && va >= x.va && va < x.va + x.n * 4096); return r ? r.pfn * 4096 + (va - r.va) : null; };
const flipPhys = (pa, mask) => { const before = emu.read_memory(pa, 1)[0]; emu.write_memory([before ^ mask], pa); return [before, emu.read_memory(pa, 1)[0]]; };

const FI = 0x18C0, SAMPLE_HK = 0x0883, CALC_HK = 0x08C1;
const flipSym = (app, sym, offset, mask) => cmdPacket(FI, 5, Buffer.concat([str(app, 20), str(sym, 32), u32(offset), u8(mask), Buffer.alloc(3)]));
const latest = (mid, since) => [...tlm].reverse().find((x) => x.mid === mid && x.t >= since);
const expected = (step) => Number((BigInt(step) * BigInt(step + 1) / 2n) & 0xffffffffn);
async function startCfs(log) {
  await sh(`cd /cfs/cpu1 && (./core-cpu1 > ${log} 2>&1 &) ; cd /`);
  for (let i = 0; i < 60; i++) { if (/^[1-9]/.test(await sh(`grep -c 'OPERATIONAL' ${log}`))) return true; await sleep(1000); }
  return false;
}

(async () => {
  try {
    await waitFor(/VM-READY/, 120000);
    record("cFS boots", await startCfs("/tmp/cfs.log"));
    send(cmdPacket(0x1880, 6, str("127.0.0.1", 16))); await sleep(3000);
    const { lines, ms } = await getMap();
    const runs = parse(lines), kr = kernel(lines);
    const pagesBy = {}; for (const r of runs) { const k = r.comm === "core-cpu1" ? r.label.replace(/:(code|data|rodata|bss)$/, ":$1") : r.comm; pagesBy[k] = (pagesBy[k] || 0) + r.n; }
    const cfsPages = runs.filter((r) => r.comm === "core-cpu1").reduce((a, r) => a + r.n, 0);
    record("Memory map over ttyS3", runs.length > 50 && kr.length > 0, `${lines.length} lines in ${ms} ms; ${lines.total}; cFS owns ${cfsPages} pages (${(cfsPages * 4 / 1024).toFixed(1)} MB) of 32768; kernel ranges: ${kr.map((k) => `${k.label}=${k.n}p`).join(" ")}`);
    const top = Object.entries(pagesBy).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join(" ");
    console.log("        largest:", top);
    const tmrRuns = runs.filter((r) => r.label.startsWith("tmr:"));
    record("TMR copies visible in physical memory", tmrRuns.length === 3, tmrRuns.map((r) => `${r.label}@pfn 0x${r.pfn.toString(16)}`).join(", "));
    record("SAMPLE_APP code located", runs.some((r) => r.label === "sample_app.so:code"), runs.filter((r) => r.label.startsWith("sample_app.so")).map((r) => `${r.label}:${r.n}p@0x${(r.pfn * 4096).toString(16)}`).join(" "));

    // 1) SAMPLE_APP counter: find its virtual address (flip it twice through FAULT_INJ = no net change), then hit it physically
    let t = Date.now(); send(flipSym("SAMPLE_APP", "SAMPLE_APP_Data", 0, 0x80)); send(flipSym("SAMPLE_APP", "SAMPLE_APP_Data", 0, 0x80));
    const ev = await waitEvent(/SYMBOL hit SAMPLE_APP/, t);
    const va = parseInt(ev.match(/@([0-9a-f]+)/)[1], 16);
    const pa = physOf(runs, va);
    await sleep(7000); const c0 = latest(SAMPLE_HK, Date.now() - 7000).bytes[16];
    const [b0, b1] = flipPhys(pa, 0x80);
    t = Date.now(); await sleep(7000); const c1 = latest(SAMPLE_HK, t).bytes[16];
    record("Physical RAM hit on SAMPLE_APP's counter shows in telemetry", pa !== null && c1 === (c0 ^ 0x80), `va 0x${va.toString(16)} -> phys 0x${pa.toString(16)}; byte ${b0.toString(16)}->${b1.toString(16)}; counter ${c0} -> ${c1}`);

    // 2) one TMR copy, physically
    const copy2 = tmrRuns.find((r) => r.label === "tmr:CALC:2");
    const pa2 = copy2.pfn * 4096 + 4;
    t = Date.now(); const [x0, x1] = flipPhys(pa2, 0x10);
    const rep = await waitEvent(/outvoted copy 2/, t).catch((e) => e.message);
    await sleep(2000); const ch = latest(CALC_HK, t); const step = ch.bytes.readUInt32LE(16), sum = ch.bytes.readUInt32LE(20);
    record("Physical hit on TMR copy 2: outvoted and repaired", /outvoted copy 2/.test(rep) && sum === expected(step), `phys 0x${pa2.toString(16)} ${x0.toString(16)}->${x1.toString(16)}; ${rep}`);

    // 3) free memory: not mapped by anyone, not the kernel image
    const used = new Set(); for (const r of runs) for (let i = 0; i < r.n; i++) used.add(r.pfn + i); for (const k of kr) for (let i = 0; i < k.n; i++) used.add(k.pfn + i);
    let freePfn = 0x2000; while (used.has(freePfn)) freePfn++;
    for (let i = 0; i < 16; i++) flipPhys(freePfn * 4096 + i * 257, 1 << (i & 7));
    await sleep(6000);
    const alive = await sh("pidof core-cpu1 || echo dead"); const ch2 = latest(CALC_HK, Date.now() - 2000);
    record("16 hits in unused memory: no effect", alive !== "dead" && ch2.bytes.readUInt32LE(20) === expected(ch2.bytes.readUInt32LE(16)), `pfn 0x${freePfn.toString(16)}; flight software pid ${alive}`);

    // 4) the map follows the software: after a restart of SAMPLE_APP its pages move
    const before = runs.filter((r) => r.label === "sample_app.so:code").map((r) => r.pfn).join(",");
    t = Date.now(); send(cmdPacket(0x1806, 6, str("SAMPLE_APP", 20))); await waitEvent(/Restart Application SAMPLE_APP/, t).catch(() => {}); await sleep(3000);
    const after = parse((await getMap()).lines).filter((r) => r.label === "sample_app.so:code").map((r) => r.pfn).join(",");
    record("Map refresh tracks software changes (SAMPLE_APP restarted)", !!after, `code pages before ${before} | after ${after}`);
  } catch (e) {
    record("Harness", false, e.message); console.log(con.slice(-1500));
  } finally {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    emu.stop(); setTimeout(() => process.exit(0), 500);
  }
})();
