// Particles and their tracks through a memory chip, and the background
// radiation of an orbit.
//
// Track model (a simplified "sensitive volume" model):
//   Under the chip surface lies a sensitive layer DEPTH cells deep (lengths are in
//   memory-cell pitches). A particle enters at a point and crosses the layer along
//   its direction. Each cell collects charge = LET × the length of track inside
//   it; a share of that spreads to the four neighbouring cells (charge sharing).
//   A cell whose charge reaches QCRIT flips.
// So a particle straight down crosses one cell; one at a low angle crosses a
// line of cells (about DEPTH × tan(angle) of them) but leaves less charge in
// each, so only heavier ions flip a whole line. What counts for ECC is where the
// line lies: along a row it stays inside one 8-byte word, across rows it spreads
// over different words.
import { bus } from "./util.js";

export const DEPTH = 2, QCRIT = 1, SHARE = 0.15, MAX_TRACK = 40;
export const PARTICLES = {
  light: { label: "light ion", let: 0.6 },    // flips a cell only on a steep path
  heavy: { label: "heavy ion", let: 2.5 },    // flips a line of cells at low angles
  iron: { label: "very heavy ion", let: 6 },  // heavy enough to spill into neighbours too
};

// dir: unit vector, chip axes (x along X, y up, z along Y); y < 0 means into the chip.
// returns the cells that flip: [{ X, Y, q }] in surface bit coordinates
export function track(X, Y, dir, LET) {
  const down = Math.max(-dir.y, 1e-3), L = Math.min(DEPTH / down, MAX_TRACK);
  const n = Math.ceil(L * 24), ds = L / n, q = new Map();
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * ds, cx = Math.floor(X + dir.x * s), cy = Math.floor(Y + dir.z * s), k = cx + "," + cy;
    q.set(k, (q.get(k) || 0) + LET * ds);
  }
  const total = new Map(q);
  for (const [k, v] of q) {
    const [cx, cy] = k.split(",").map(Number);
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nk = (cx + ax) + "," + (cy + ay); total.set(nk, (total.get(nk) || 0) + v * SHARE); }
  }
  const out = [];
  for (const [k, v] of total) if (v >= QCRIT) { const [cx, cy] = k.split(",").map(Number); out.push({ X: cx, Y: cy, q: v }); }
  return out;
}

// directions in space come from everywhere; through a flat surface the flux goes as cos(angle)
export function randomDirection(rand = Math.random) {
  const cos = Math.sqrt(1 - rand()), sin = Math.sqrt(1 - cos * cos), phi = rand() * 2 * Math.PI;
  return { x: sin * Math.cos(phi), y: -cos, z: sin * Math.sin(phi) };
}
// The cosmic-ray spectrum falls steeply with LET: almost all particles are light. This mix makes
// about 3% of upset events multi-cell, inside the range seen in orbit (1-20% on older DRAM,
// 1.4% on Alsat-1's SRAM, "rare" on modern SDRAM).
export const SPECTRUM = { light: 0.9912, heavy: 0.008, iron: 0.0008 };
// a solar flare burst is far richer in energetic particles
export const FLARE_SPECTRUM = { light: 0.9, heavy: 0.09, iron: 0.01 };
export function randomParticle(rand = Math.random, mix = SPECTRUM) { const r = rand(); return r < mix.light ? "light" : r < mix.light + mix.heavy ? "heavy" : "iron"; }

// ---- background radiation ----
// Design point: a modern SDRAM in low Earth orbit. NASA's solid-state recorder guidelines put
// per-bit SDRAM upset rates at 1e-13 to 1e-11 per day (LRO's 512 Mbit SDRAM measured 6.8e-12);
// LEO adds the South Atlantic Anomaly's protons, so the orbit average is set at the top of that
// range: 1e-11 upsets per bit per day, about one upset in 64 MB every six months.
export const RATE_PER_BIT_DAY = 1e-11;
// Each environment is a multiple of that orbit average, from flight data:
//  - SeaStar (705 km): over 80% of upsets inside the SAA in under 20% of the orbit, so
//    inside the SAA ~4x the average and outside it ~0.25x
//  - solar particle events: 5-20x background (SeaStar ~5x, TDRS-1 10-20x, CREAM 3-6x)
//  - CREME96 "worst day" design spectrum: predicted ~1,500x SeaStar's background,
//    two to three orders of magnitude above what flew; a conservative design case
export const ENVIRONMENTS = {
  orbit: { label: "LEO orbit average", factor: 1 },
  quiet: { label: "LEO outside the SAA", factor: 0.25 },
  saa: { label: "Inside the South Atlantic Anomaly", factor: 4 },
  spe: { label: "Solar particle event (as observed)", factor: 10 },
  worst: { label: "Design worst day (CREME96)", factor: 1500 },
  stress: { label: "Accelerated test (beyond reality)", factor: 3e6 },
};
export const WARPS = [
  { label: "real time", s: 1 },
  { label: "1 hour per second", s: 3600 },
  { label: "1 day per second", s: 86400 },
  { label: "1 week per second", s: 604800 },
  { label: "1 month per second", s: 2592000 },
  { label: "1 year per second", s: 31536000 },
];
const MAX_STRIKES_PER_S = 300;   // the page keeps up to this; above it the rate is capped (and shown)

// How many bits one random particle flips on average, over the spectrum and all directions:
// used to turn a per-bit upset rate into particles per day.
export function meanCellsPerParticle(samples = 30000) {
  let cells = 0, events = 0, multi = 0;
  for (let i = 0; i < samples; i++) {
    const n = track(Math.random() * 16, Math.random() * 16, randomDirection(), PARTICLES[randomParticle()].let).length;
    cells += n; if (n) events++; if (n > 1) multi++;
  }
  return { cells: cells / samples, multiShare: events ? multi / events : 0 };
}

export class Background {
  constructor({ fc, board }) {
    this.fc = fc; this.board = board;
    this.on = false; this.env = "orbit"; this.warp = 2592000; this.wasUp = false;
    // calibrate: particles per day on the board that give RATE_PER_BIT_DAY on the RAM
    const m = meanCellsPerParticle();
    this.cal = { cellsPerParticle: m.cells, multiShare: m.multiShare, ramBits: fc.pages * 4096 * 8, ramShare: board.ramShare };
    this.cal.particlesPerDay = RATE_PER_BIT_DAY * this.cal.ramBits / (board.ramShare * m.cells);
    this.resetStats();
    let last = performance.now();
    setInterval(() => { const now = performance.now(), dt = (now - last) / 1000; last = now; this.step(Math.min(dt, 1)); }, 100);
    // mission statistics count everything (clicks and background alike) from the first time
    // the flight software is up: that moment is launch, T+0
    const live = () => this.s.started;
    bus.on("ram-hit", (e) => { if (!live()) return; this.s.bits += e.bits || 0; for (const [k, n] of Object.entries(e.outcomes || {})) this.s.out[k] = (this.s.out[k] || 0) + n; });
    bus.on("fsw-down", () => { if (live()) this.s.crashes++; });
    bus.on("reset", (e) => { if (live()) this.s.resets[e.reason] = (this.s.resets[e.reason] || 0) + 1; });
    bus.on("calc-wrong", () => { if (live()) this.s.wrong++; });
    bus.on("state", (e) => {
      const up = e.state === "operational";
      if (up && !this.s.started) this.s.started = true;
      if (this.s.started && this.wasUp && !up) this.s.outages++;
      this.wasUp = up;
    });
    bus.on("telemetry", () => {
      const c = this.fc.app.calc; if (!c) return;
      if (live() && this.lastRepairs !== null && c.repairs > this.lastRepairs) this.s.tmrRepairs += c.repairs - this.lastRepairs;
      this.lastRepairs = c.repairs;
    });
    bus.on("power-on", () => { this.lastRepairs = null; });
  }
  // missionS: mission time since launch. upS/downS: mission seconds with the flight software up and down.
  // Time warp only runs while the flight software is up. An outage plays out in real time on both the
  // clock and the radiation, so a 30 s reboot costs 30 s of mission time, as it would in orbit, and
  // uptime = upS / missionS means what it means for a real satellite.
  resetStats() {
    const up = this.fc.operational;
    this.s = { started: up, missionS: 0, realS: 0, upS: 0, downS: 0, outages: 0, strikes: 0, ram: 0, sd: 0, bits: 0, out: {}, crashes: 0, resets: {}, wrong: 0, tmrRepairs: 0 };
    this.lastRepairs = null; this.wasUp = up;
    bus.emit("stats-reset", { bg: this });
  }
  set(opts) {
    if (opts.on !== undefined) this.on = opts.on;
    if (opts.env) this.env = opts.env;
    if (opts.warp) this.warp = opts.warp;
    bus.emit("bg-settings", { bg: this });
  }
  // the warp in force right now: none while the flight software is down
  get warpNow() { return this.on && this.fc.operational ? this.warp : 1; }
  // particles per real second on the board, and whether the page had to cap it
  get wanted() { return this.cal.particlesPerDay * ENVIRONMENTS[this.env].factor / 86400 * this.warpNow; }
  get rate() { return Math.min(this.wanted, MAX_STRIKES_PER_S); }
  get capped() { return this.on && this.wanted > MAX_STRIKES_PER_S; }
  // expected RAM upsets per day of mission time in this environment, and per real second now
  get upsetsPerDay() { return RATE_PER_BIT_DAY * ENVIRONMENTS[this.env].factor * this.cal.ramBits; }
  step(dt) {
    const s = this.s;
    if (s.started) {
      const m = dt * this.warpNow;
      s.missionS += m; s.realS += dt;
      if (this.fc.operational) s.upS += m; else s.downS += m;
    }
    if (!this.on) return;
    let n = poisson(this.rate * dt);
    while (n-- > 0) {
      const r = this.board.randomStrike(randomParticle(), randomDirection());
      s.strikes++; if (r && r.surface === "ram") s.ram++; if (r && r.surface === "sd") s.sd++;
    }
    bus.emit("bg-progress", { fc: this.fc, stats: s, bg: this });
  }
}
function poisson(lambda) {
  if (lambda > 30) return Math.round(lambda + Math.sqrt(lambda) * gauss());
  let k = 0, p = Math.exp(-lambda), cum = p; const u = Math.random();
  while (u > cum) { k++; p *= lambda / k; cum += p; }
  return k;
}
function gauss() { return Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random()); }

// a real-time duration, short: "42 s", "3 min 10 s", "1 h 4 min"
export function formatShort(sec) {
  sec = Math.round(sec);
  return sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${Math.floor(sec / 3600)} h ${Math.floor(sec % 3600 / 60)} min`;
}
export function formatMission(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min ${Math.floor(sec % 60)} s`;
}
