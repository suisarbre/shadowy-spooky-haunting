// OS adapter: Linux + NASA cFS.
//
// The emulated hardware (hardware.js) knows nothing about the software it runs.
// Everything specific to one OS and flight software lives in an adapter like
// this one. To try another OS, write another adapter and point main.js at it.
//
// What the hardware expects from the guest (see os/README.md):
//   ttyS0  console      free text; the adapter's patterns read it
//   ttyS1  radio        "C<hex>\n" up (commands), "T<hex>\n" down (telemetry)
//   ttyS2  watchdog     "WS<ms>" set timeout, "WE" enable, "WD" disable, "WK" kick
//   ttyS3  diagnostics  on "M\n": "MB", then "K <pfn> <n> <label>" (kernel) or
//                       "R <pfn> <n> <va> <pid> <comm> <label>" (process) lines, then "ME"
// The guest side of that contract here: serbridge (ttyS1), a PSP watchdog patch
// that drives ttyS2 from cFS Health & Safety, and memmap (ttyS3), all in build/.

// ---- CCSDS command packets (little-endian payloads) ----
function cmdPacket(mid, fc, payload = new Uint8Array(0)) {
  const p = new Uint8Array(8 + payload.length);
  p[0] = mid >> 8; p[1] = mid & 255; p[2] = 0xc0; p[3] = 0; const len = p.length - 7; p[4] = len >> 8; p[5] = len & 255;
  p[6] = fc; p.set(payload, 8);
  let x = 0xff; for (const v of p) x ^= v; p[7] = x;
  return p;
}
const str = (t, n) => { const o = new Uint8Array(n); for (let i = 0; i < t.length && i < n; i++) o[i] = t.charCodeAt(i); return o; };

export const commands = {
  toEnable: () => cmdPacket(0x1880, 6, str("127.0.0.1", 16)),   // turn on the downlink (TO_LAB)
  calcReset: () => cmdPacket(0x18c1, 1),
  calcTmr: (on) => cmdPacket(0x18c1, 2, new Uint8Array([on ? 1 : 0, 0, 0, 0])),
};

// the ground knows the right answer: 1 + 2 + … + step, modulo 2^32 like the flight code
export const calcExpected = (step) => Number((BigInt(step) * BigInt(step + 1) / 2n) & 0xffffffffn);
export const calcOk = (c) => !!c && c.sum === calcExpected(c.step);

const LIBS = /^(libc|libm|ld-linux|libgcc|libpthread|librt|libdl)/;

export default {
  name: "Linux + NASA cFS",
  images: { kernel: "bzImage", rootfs: "initrd.gz" },
  cmdline: "console=ttyS0 rdinit=/init quiet loglevel=3 fsw=auto",
  fswProcess: "core-cpu1",

  // console patterns (ttyS0)
  patterns: {
    fswStarting: /FSW-AUTOSTART/,
    shellReady: /VM-READY/,
    operational: /entering OPERATIONAL/,
    fswExit: /FSW-EXIT (\d+)/,
    corruptExec: /exec format|not found|can't execute|syntax error/i,
    panic: /Kernel panic/,
    probeDown: /FSW-DOWN\r?\n/,
    probeAlive: /FSW-ALIVE\r?\n/,
  },
  // an image without autostart boots to a shell: start the flight software from there
  startCommand: "cd /cfs/cpu1 && { ./core-cpu1 2>&1; echo \"FSW-EXI\"\"T $?\"; } | grep -E 'OPERATIONA[L]|ERRO[R]|Restar[t]|FSW-EXI[T]|Could not loa[d]' &",
  // telemetry went quiet: is the flight software process still there? (quoting keeps the echo from matching)
  probeCommand: "pidof core-cpu1 >/dev/null && echo FSW-ALIV'E' || echo FSW-DOW'N'",

  // called once the flight software is up
  onOperational(fc) { fc.send(commands.toEnable()); },

  // telemetry packet (bytes) -> fc.app state, plus events for the log
  telemetry(fc, b) {
    const mid = (b[0] << 8) | b[1];
    const u32at = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
    const app = fc.app;
    if (mid === 0x0808) {
      // CCSDS header (16 bytes) + AppName[20] + EventID, EventType, SC ID, CPU ID (12 bytes) + Message[122]
      const cstr = (o, n) => { let t = ""; for (let i = o; i < o + n && i < b.length && b[i]; i++) t += String.fromCharCode(b[i]); return t; };
      const evType = ["", "DEBUG", "INFO", "ERROR", "CRIT"][b[38] | (b[39] << 8)] || "?";
      fc.log(`${cstr(16, 20)} ${evType}: ${cstr(48, 122)}`, "fsw");
    }
    if (mid === 0x0883) app.counter = b[16];
    if (mid === 0x08c1 && b.length >= 68) {
      const prev = app.calc;
      app.calc = { step: u32at(16), sum: u32at(20), copies: [u32at(24), u32at(28), u32at(32)], repairs: u32at(48), on: b[64] === 1, mask: b[65], t: Date.now() };
      if (app.calc.mask) { app.lastRepair = { mask: app.calc.mask, copies: app.calc.copies.slice(), t: Date.now() }; fc.emit("tmr-repair", { mask: app.calc.mask, copies: app.calc.copies }); }
      const ok = calcOk(app.calc);
      if (prev && calcOk(prev) && !ok) fc.emit("calc-wrong", { calc: app.calc });
      if (prev && !calcOk(prev) && ok) fc.emit("calc-right", { calc: app.calc });
    }
  },
  freshApp: () => ({ counter: null, calc: null, lastRepair: null }),

  // memory map: what kind of thing a run of pages holds (drives the colours)
  categorize(comm, label) {
    if (label.startsWith("tmr:")) return "tmr" + label.split(":")[2];
    if (comm === "doom") return LIBS.test(label) ? "lib" : "payload";   // the uplinked payload application
    if (comm !== "core-cpu1") return LIBS.test(label) ? "lib" : "other";
    if (LIBS.test(label)) return "lib";
    if (label.startsWith("core-cpu1") || /^(heap|stack|anon|bss)$/.test(label) || label.startsWith("SYSV")) return "fsw";
    return /\.so:/.test(label) ? "app" : "fsw";
  },
  // boot storage: what kind of thing a file is
  categorizeFile(name) {
    if (name === "cfs/cpu1/core-cpu1") return "fsw";
    if (name.startsWith("cfs/")) return "app";
    if (/^lib/.test(name)) return "lib";
    if (name.startsWith("payload/")) return "payload";
    return "other";
  },
  // the TMR calculator's three copies, by memory-map label
  tmrLabel: (k) => `tmr:CALC:${k}`,
};
