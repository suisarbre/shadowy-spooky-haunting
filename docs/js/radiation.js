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
// the galactic cosmic ray spectrum falls steeply with LET: mostly light ions
export function randomParticle(rand = Math.random) { const r = rand(); return r < 0.9 ? "light" : r < 0.995 ? "heavy" : "iron"; }

// ---- background radiation ----
// Strikes per mission day on the whole board. These are illustrative orders of
// magnitude, not data for a particular device: a modern SDRAM in low Earth orbit
// sees roughly one upset in its 64 MB every few weeks; passes through the South
// Atlantic Anomaly and solar particle events raise that many times over.
export const ENVIRONMENTS = {
  quiet: { label: "Quiet low Earth orbit", perDay: 0.25 },
  saa: { label: "South Atlantic Anomaly pass", perDay: 10 },
  flare: { label: "Solar particle event", perDay: 150 },
  stress: { label: "Stress test (far beyond reality)", perDay: 15000 },
};
export const WARPS = [
  { label: "1 minute per second", s: 60 },
  { label: "1 hour per second", s: 3600 },
  { label: "1 day per second", s: 86400 },
  { label: "1 week per second", s: 604800 },
];

export class Background {
  constructor({ fc, board }) {
    this.fc = fc; this.board = board;
    this.on = false; this.env = "flare"; this.warp = 86400;
    this.resetStats();
    let last = performance.now();
    setInterval(() => { const now = performance.now(), dt = (now - last) / 1000; last = now; if (this.on) this.step(Math.min(dt, 1)); }, 100);
    bus.on("ram-hit", (e) => { if (!this.on) return; this.s.bits += e.bits || 0; for (const [k, n] of Object.entries(e.outcomes || {})) this.s.out[k] = (this.s.out[k] || 0) + n; });
    bus.on("fsw-down", () => { if (this.on) this.s.crashes++; });
    bus.on("reset", (e) => { if (this.on) this.s.resets[e.reason] = (this.s.resets[e.reason] || 0) + 1; });
    bus.on("calc-wrong", () => { if (this.on) this.s.wrong++; });
    bus.on("telemetry", () => {
      const c = this.fc.app.calc; if (!c) return;
      if (this.on && this.lastRepairs !== null && c.repairs > this.lastRepairs) this.s.tmrRepairs += c.repairs - this.lastRepairs;
      this.lastRepairs = c.repairs;
    });
    bus.on("power-on", () => { this.lastRepairs = null; });
  }
  resetStats() { this.s = { missionS: 0, realS: 0, upS: 0, strikes: 0, ram: 0, sd: 0, bits: 0, out: {}, crashes: 0, resets: {}, wrong: 0, tmrRepairs: 0 }; this.lastRepairs = null; }
  set(opts) {
    if (opts.on !== undefined) this.on = opts.on;
    if (opts.env) this.env = opts.env;
    if (opts.warp) this.warp = opts.warp;
    bus.emit("bg-settings", { bg: this });
  }
  // strikes per real second, capped so the page keeps up
  get rate() { return Math.min(ENVIRONMENTS[this.env].perDay / 86400 * this.warp, 40); }
  step(dt) {
    const s = this.s;
    s.missionS += dt * this.warp; s.realS += dt; if (this.fc.operational) s.upS += dt;
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

export function formatMission(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min ${Math.floor(sec % 60)} s`;
}
