// 3D view: a CubeSat in orbit, with the flight computer board inside it and a
// semantic zoom on its memory chips. Turn it, zoom in through the hull (which
// turns to x-ray up close), and the view settles onto the memory.
//
// Each memory chip's top is the memory itself, laid out like a hex dump: every
// 4 KB page is a tile 16 bytes wide and 256 rows tall, each byte 8 bits across
// (most significant bit on the left). Far away a page is one coloured pixel
// (who owns it); zoom in and the tile shows its bytes as brightness, then its
// bits, then 0s and 1s you can read and click. The same point on the chip
// always means the same byte and bit, so a click is an exact hit.
import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";   // three.js r160, bundled
import { hex2, hexAddr } from "./util.js";
import { WORD } from "./ecc.js";
import { track, PARTICLES, randomDirection, randomParticle } from "./radiation.js";

export const COLORS = { free: "#161b22", kernel: "#8957e5", fsw: "#1f6feb", app: "#2ea043", tmr1: "#ff7b72", tmr2: "#ffa657", tmr3: "#e3b341", lib: "#6e7681", other: "#3b4048", damaged: "#f85149" };
const RGB = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))]));
const ON_BIT = { free: [125, 133, 144] };   // free pages: grey bits instead of near-black
const PAGE = 4096, PX = 128, PY = 256;
// a page tile: 128 bits across, 256 rows down
const SD_DAMAGE_SHARE = 0.02;   // background particles on the SD card that leave lasting damage
const S = 0.86 / 9;              // the 9-unit board, scaled to fit inside a 1-unit (10 cm) CubeSat

// A memory chip whose top face is a memory surface.
class Surface {
  constructor(kind, cols, pages, width) {
    this.kind = kind; this.cols = cols; this.pages = pages; this.rows = Math.ceil(pages / cols);
    this.TX = cols * PX; this.TY = this.rows * PY;                       // the whole surface in bits
    this.w = width; this.d = width * (this.rows * 2) / cols;             // page tiles are twice as tall as wide
    this.bitU = width / this.TX;                                         // one bit, in board units
    this.bitW = this.bitU * S;                                           // one bit, in world units
    const cv = document.createElement("canvas"); cv.width = cols; cv.height = this.rows * 2;
    this.canvas = cv;
  }
  // bit coordinates <-> addresses
  at(X, Y) {
    X = Math.max(0, Math.min(this.TX - 1, Math.floor(X))); Y = Math.max(0, Math.min(this.TY - 1, Math.floor(Y)));
    const page = Math.floor(Y / PY) * this.cols + Math.floor(X / PX), xb = X % PX, yb = Y % PY;
    return { addr: page * PAGE + yb * 16 + (xb >> 3), bit: 7 - (xb & 7), page };
  }
  xy(addr, bit = 7) {
    const page = Math.floor(addr / PAGE), byte = addr % PAGE;
    return { X: (page % this.cols) * PX + (byte % 16) * 8 + (7 - bit) + 0.5, Y: Math.floor(page / this.cols) * PY + Math.floor(byte / 16) + 0.5 };
  }
  local(X, Y) { return new THREE.Vector3(-this.w / 2 + X / this.TX * this.w, this.h / 2, -this.d / 2 + Y / this.TY * this.d); }
}

export function createBoard({ host, fc, os, particle, onStrike, zoomInput, ticks, stageEl, hintEl }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.prepend(renderer.domElement);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#03040a");
  const camera = new THREE.PerspectiveCamera(40, 1, 1e-6, 3000);
  const controls = new OrbitControls(camera, renderer.domElement);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, zoomToCursor: true, zoomSpeed: 1.6, rotateSpeed: 0.7, screenSpacePanning: true, maxDistance: 6.5, autoRotate: !reduce, autoRotateSpeed: 0.35 });
  let idleTimer, touching = false;
  controls.addEventListener("start", () => { touching = true; controls.autoRotate = false; clearTimeout(idleTimer); });
  controls.addEventListener("end", () => { touching = false; clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!reduce && dist() > 2.5) controls.autoRotate = true; }, 6000); });
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6); sun.position.set(6, 4, 3); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x5a7fb8, 0x0a0d14, 1.1));

  // ---- space: far stars, and a thin limb of Earth below ----
  {
    const n = 5000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 900 + Math.random() * 500, t = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, q = Math.sqrt(1 - u * u);
      pos.set([r * q * Math.cos(t), r * u, r * q * Math.sin(t)], i * 3);
      const w = 0.5 + Math.random() * 0.5; col.set(Math.random() < 0.15 ? [w, w * 0.85, w * 0.7] : [w * 0.85, w * 0.92, w], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, vertexColors: true, sizeAttenuation: false })));
    const atmo = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: "varying vec3 n; varying vec3 v; void main(){ n = normalize(normalMatrix * normal); vec4 p = modelViewMatrix * vec4(position,1.0); v = normalize(-p.xyz); gl_Position = projectionMatrix * p; }",
      fragmentShader: "varying vec3 n; varying vec3 v; void main(){ float f = pow(1.0 - abs(dot(n, v)), 5.0); gl_FragColor = vec4(vec3(0.35,0.66,1.0) * f * 1.8, f); }",
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(300, 128, 64), new THREE.MeshBasicMaterial({ color: "#03060d" }));
    earth.position.set(0, -340, -120); scene.add(earth);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(306, 128, 64), atmo); glow.position.copy(earth.position); scene.add(glow);
  }
  let dirty = true; const redraw = () => { dirty = true; };
  controls.addEventListener("change", () => { dirty = true; overlayDue = true; });

  // ---- the board ----
  const ram = new Surface("ram", 256, fc.pages, 5);
  const sd = new Surface("sd", 64, Math.ceil(fc.sdBytes() / PAGE), 2.4);
  // closest view: about 24 rows of bits on screen
  controls.minDistance = ram.bitW * 24 / (2 * Math.tan(20 * Math.PI / 180));

  // ---- the CubeSat: 10 cm cube, solar cells, rails, two deployed wings ----
  const sat = new THREE.Group(); scene.add(sat);
  const cellTex = (cols, rows) => {
    const c = document.createElement("canvas"); c.width = 512; c.height = 512 * rows / cols; const g = c.getContext("2d"), w = c.width / cols, h = c.height / rows;
    g.fillStyle = "#c9ccd4"; g.fillRect(0, 0, c.width, c.height);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const grd = g.createLinearGradient(x * w, y * h, (x + 1) * w, (y + 1) * h); grd.addColorStop(0, "#22367a"); grd.addColorStop(1, "#0c1636");
      g.fillStyle = grd; g.fillRect(x * w + 5, y * h + 5, w - 10, h - 10);
      g.strokeStyle = "rgba(200,212,240,0.32)"; g.lineWidth = 1.2;
      for (let k = 1; k < 7; k++) { g.beginPath(); g.moveTo(x * w + 5, y * h + 5 + k * (h - 10) / 7); g.lineTo((x + 1) * w - 5, y * h + 5 + k * (h - 10) / 7); g.stroke(); }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  };
  const hullMats = [], hullMeshes = [];
  const hm = (o) => { const m = new THREE.MeshStandardMaterial({ transparent: true, ...o }); m.userData.base = m.opacity; m.userData.depth = m.depthWrite; hullMats.push(m); return m; };
  const hullAdd = (m) => { sat.add(m); hullMeshes.push(m); return m; };
  // the cube's walls are see-through, so the flight computer shows from outside
  const sideM = hm({ map: cellTex(2, 2), metalness: 0.35, roughness: 0.4, opacity: 0.38, depthWrite: false }), capM = hm({ color: "#c79f58", metalness: 0.9, roughness: 0.3, opacity: 0.3, depthWrite: false });
  hullAdd(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [sideM, sideM, capM, capM, sideM, sideM]));
  const railM = hm({ color: "#b8bfcc", metalness: 1, roughness: 0.25 });
  for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) { const r = hullAdd(new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.06), railM)); r.position.set(x, 0, z); }
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: "#7cc4ff", transparent: true, opacity: 0.25 })); sat.add(edges);
  const wingM = hm({ map: cellTex(2, 4), metalness: 0.35, roughness: 0.4, side: THREE.DoubleSide });
  for (const sx of [-1, 1]) {
    const hinge = hullAdd(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.03), railM)); hinge.position.set(sx * 0.57, 0.3, 0);
    const wing = hullAdd(new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.025, 0.95), wingM)); wing.position.set(sx * 1.64, 0.3, 0);
  }
  const ant = hullAdd(new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 1.4), hm({ color: "#e2e6ee", metalness: 1, roughness: 0.2 })));
  ant.position.set(0.2, -0.53, 0); ant.rotation.x = Math.PI / 2;
  // the flight computer board, inside
  const group = new THREE.Group(); group.scale.setScalar(S); group.position.y = -0.06; sat.add(group);
  const satQ = new THREE.Quaternion();
  const toLocalDir = (w) => { sat.getWorldQuaternion(satQ); const v = new THREE.Vector3(w.x, w.y, w.z).applyQuaternion(satQ.invert()); return { x: v.x, y: v.y, z: v.z }; };
  const toWorldDir = (l) => { sat.getWorldQuaternion(satQ); return new THREE.Vector3(l.x, l.y, l.z).applyQuaternion(satQ); };
  const silk = document.createElement("canvas"); silk.width = 900; silk.height = 600;
  { const g = silk.getContext("2d");
    g.fillStyle = "#0e3b2c"; g.fillRect(0, 0, 900, 600); g.strokeStyle = "#1d6b4f"; g.lineWidth = 3;
    for (let k = 0; k < 14; k++) { g.beginPath(); g.moveTo(40 + k * 60, 560); g.lineTo(40 + k * 60, 470); g.lineTo(80 + k * 50, 420); g.stroke(); }
    g.fillStyle = "#d8f3e6"; g.font = "22px system-ui, sans-serif";
    g.fillText(`SDRAM ${fc.memMb - 64 > 0 ? `64 MB (+${fc.memMb - 64} MB boot staging)` : "64 MB"}`, 40, 34); g.fillText("SD CARD (boot storage)", 600, 34);
    g.fillText("CPU", 120, 588); g.fillText("WATCHDOG", 395, 588); g.fillText("FRAM 512 KB", 690, 588);
  }
  const chip = (w, d, h, canvas, nearest) => {
    const side = new THREE.MeshStandardMaterial({ color: "#1c2128", roughness: 0.8 });
    const tex = new THREE.CanvasTexture(canvas); tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }), side, side, side]);
    m.userData.tex = tex; return m;
  };
  const label = (text, w = 256, h = 256) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#1c2128"; g.fillRect(0, 0, w, h); g.fillStyle = "#c9d1d9"; g.font = `bold ${Math.round(h / 5)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, w / 2, h / 2); return c; };
  const pcb = chip(9, 6.6, 0.16, silk); pcb.userData.kind = "board"; group.add(pcb);
  for (const [s, x] of [[ram, -1.55], [sd, 2.95]]) {
    s.h = 0.22; s.mesh = chip(s.w, s.d, s.h, s.canvas, true);
    s.mesh.position.set(x, 0.08 + s.h / 2, -3.3 + 0.35 + s.d / 2); s.mesh.userData.kind = s.kind; s.mesh.userData.surface = s; group.add(s.mesh);
  }
  const cpu = chip(1.8, 1.8, 0.3, label("CPU")); cpu.position.set(-2.9, 0.23, 2.15); cpu.userData.kind = "cpu"; group.add(cpu);
  const wdt = chip(0.9, 0.9, 0.22, label("WDT", 128, 128)); wdt.position.set(0.15, 0.19, 2.4); wdt.userData.kind = "wdt"; group.add(wdt);
  const fram = chip(1.3, 0.9, 0.2, label("FRAM", 192, 128)); fram.position.set(3.1, 0.18, 2.4); fram.userData.kind = "fram"; group.add(fram);
  const pickables = [ram.mesh, sd.mesh, cpu, wdt, fram, pcb];

  // ---- base textures: one pixel per page (two tall), coloured by owner ----
  function drawBase(s) {
    const g = s.canvas.getContext("2d"), img = g.createImageData(s.canvas.width, s.canvas.height), d = img.data;
    for (let p = 0; p < s.cols * s.rows; p++) {
      const col = RGB[pageCat(s, p)] || RGB.other, x = p % s.cols, y = Math.floor(p / s.cols) * 2;
      for (const yy of [y, y + 1]) { const i = (yy * s.cols + x) * 4; d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255; }
    }
    g.putImageData(img, 0, 0); s.mesh.userData.tex.needsUpdate = true; dirty = true;
  }
  let sdDamagedPages = new Set();
  function pageCat(s, p) {
    if (p >= s.pages) return "free";
    if (s.kind === "ram") { const r = fc.map ? fc.map.pageRun[p] : -1; return r >= 0 ? fc.map.runs[r].cat : "free"; }
    if (sdDamagedPages.has(p)) return "damaged";
    return fc.describeSd(p * PAGE).cat;
  }
  const refreshSd = () => { sdDamagedPages = new Set([...fc.sd.diffs.keys()].map((i) => Math.floor(i / PAGE))); drawBase(sd); };
  drawBase(ram); refreshSd();

  // ---- framing ----
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    // a tall phone screen needs to stand further back to fit the wings
    MAX_D = Math.max(6.5, homePose().dist * 1.3); controls.maxDistance = MAX_D; placeTicks && placeTicks();
    dirty = true; overlayDue = true; if (!moved) home(false);
  }
  let MAX_D = 6.5, placeTicks = null;
  let moved = false; controls.addEventListener("start", () => { moved = true; flight = null; });
  // the whole satellite, wings included, from a three-quarter view
  function homePose() {
    const hfov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
    return { target: new THREE.Vector3(0, 0, 0), dist: Math.max(4.4, 1.25 * 2.7 / Math.tan(hfov / 2)), dir: new THREE.Vector3(0.6, 0.35, 0.72).normalize() };
  }
  function home(animate = true) { const p = homePose(); if (animate) fly(p.target, p.dist, p.dir); else { camera.position.copy(p.target).addScaledVector(p.dir, p.dist); controls.target.copy(p.target); controls.update(); } dirty = true; }

  // ---- camera flights (log-distance interpolation, so zooming 10000x looks smooth) ----
  let flight = null;
  function fly(target, dist, dir) {
    const from = { target: controls.target.clone(), dist: camera.position.distanceTo(controls.target), dir: camera.position.clone().sub(controls.target).normalize() };
    flight = { from, to: { target: target.clone(), dist, dir: (dir || from.dir).clone().normalize() }, t0: performance.now(), ms: 1100 };
  }
  function stepFlight(now) {
    if (!flight) return;
    const k = Math.min(1, (now - flight.t0) / flight.ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const { from, to } = flight;
    const tgt = from.target.clone().lerp(to.target, e), dist = Math.exp(Math.log(from.dist) * (1 - e) + Math.log(to.dist) * e);
    const dir = from.dir.clone().lerp(to.dir, e).normalize();
    controls.target.copy(tgt); camera.position.copy(tgt).addScaledVector(dir, dist); controls.update();
    dirty = true; overlayDue = true;
    if (k >= 1) flight = null;
  }
  // fly to a byte: close enough to read about `bits` bits across the screen
  function flyTo(kind, addr, bits = 40) {
    const s = kind === "sd" ? sd : ram, { X, Y } = s.xy(addr, 7);
    bits = Math.min(bits, Math.max(16, Math.floor(el.clientWidth / 20)));   // readable 0s and 1s on narrow screens too
    // centre on the first 8 bytes from there (one ECC word), seen almost from above
    const p = s.mesh.localToWorld(s.local(X - 0.5 + 32, Y + 3));
    const hfov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect), vfov = camera.fov * Math.PI / 180;
    const dist = Math.max(controls.minDistance, bits * s.bitW / (2 * Math.tan(hfov / 2)), 16 * s.bitW / (2 * Math.tan(vfov / 2)));
    fly(p, dist, new THREE.Vector3(0, 0.97, 0.24)); moved = true;
  }
  function zoomBy(f) {
    const d = camera.position.distanceTo(controls.target), dir = camera.position.clone().sub(controls.target).normalize();
    fly(controls.target, Math.max(controls.minDistance, Math.min(controls.maxDistance, d * f)), dir); moved = true;
  }

  // ---- the semantic zoom overlay ----
  const overlay = { canvas: document.createElement("canvas"), level: "none", region: null, prev: null, changed: new Map(), hits: new Map() };
  for (const s of [ram, sd]) {
    const tex = new THREE.CanvasTexture(overlay.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    s.ovTex = tex;
    s.ov = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, depthTest: false, toneMapped: false }));
    s.ov.renderOrder = 10; s.ov.visible = false; s.mesh.add(s.ov);
  }
  let overlayDue = true, lastOverlay = 0;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  // where a screen point (-1..1) meets a surface's top plane, in surface bit coordinates
  const tmpQ = new THREE.Quaternion();
  function screenToBits(s, x, y) {
    ndc.set(x, y); ray.setFromCamera(ndc, camera);
    const p0 = s.mesh.localToWorld(new THREE.Vector3(0, s.h / 2, 0)), n = new THREE.Vector3(0, 1, 0).applyQuaternion(s.mesh.getWorldQuaternion(tmpQ));
    const dn = ray.ray.direction.dot(n); if (dn > -1e-6) return null;
    const t = p0.clone().sub(ray.ray.origin).dot(n) / dn; if (t <= 0) return null;
    const l = s.mesh.worldToLocal(ray.ray.origin.clone().addScaledVector(ray.ray.direction, t));
    return { X: (l.x + s.w / 2) / s.w * s.TX, Y: (l.z + s.d / 2) / s.d * s.TY, dist: t };
  }
  function updateOverlay() {
    overlayDue = false; lastOverlay = performance.now();
    let best = null;
    for (const s of [ram, sd]) {
      const c = screenToBits(s, 0, 0);
      if (!c || c.X < -s.TX * 0.05 || c.X > s.TX * 1.05 || c.Y < -s.TY * 0.05 || c.Y > s.TY * 1.05) { s.ov.visible = false; continue; }
      const pxPerUnit = renderer.domElement.clientHeight / (2 * c.dist * Math.tan(camera.fov * Math.PI / 360));
      const bitPx = s.bitW * pxPerUnit;
      if (!best || bitPx > best.bitPx) { if (best) best.s.ov.visible = false; best = { s, c, bitPx }; } else s.ov.visible = false;
    }
    if (!best) { overlay.level = "none"; dirty = true; return; }
    const { s, c, bitPx } = best, pagePx = bitPx * PX;
    const level = pagePx < 48 ? "none" : bitPx < 2.5 ? "bytes" : bitPx < 10 ? "bits" : "text";
    if (level === "none") { s.ov.visible = false; overlay.level = "none"; dirty = true; return; }
    // the visible part of the surface, from the screen edges
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [0, -1], [-1, 0], [1, 0], [0, 0]]) {
      const p = screenToBits(s, x, y); if (!p || p.dist > c.dist * 6) continue;
      X0 = Math.min(X0, p.X); X1 = Math.max(X1, p.X); Y0 = Math.min(Y0, p.Y); Y1 = Math.max(Y1, p.Y);
    }
    // at most this many cells across and down, centred on the middle of the screen, so a refresh stays cheap
    // (bytes covers everything in view and samples it down; bits and text are capped)
    const unit = level === "bytes" ? 8 : 1, [capX, capY] = { bytes: [8192, 16384], bits: [640, 640], text: [140, 100] }[level];
    const cx = c.X, cy = c.Y;
    X0 = Math.max(0, X0, cx - capX / 2 * unit); X1 = Math.min(s.TX, X1, cx + capX / 2 * unit);
    Y0 = Math.max(0, Y0, cy - capY / 2); Y1 = Math.min(s.TY, Y1, cy + capY / 2);
    X0 = Math.floor(X0 / unit) * unit; X1 = Math.ceil(X1 / unit) * unit; Y0 = Math.floor(Y0); Y1 = Math.ceil(Y1);
    if (X1 <= X0 || Y1 <= Y0) { s.ov.visible = false; return; }
    overlay.level = level; overlay.region = { s, X0, Y0, X1, Y1 };
    drawOverlay(s, level, X0, Y0, X1, Y1);
    // place the plane over exactly that region, just above the chip
    s.ov.position.set(-s.w / 2 + (X0 + X1) / 2 / s.TX * s.w, s.h / 2 + 1e-5, -s.d / 2 + (Y0 + Y1) / 2 / s.TY * s.d);
    s.ov.scale.set((X1 - X0) / s.TX * s.w, 1, (Y1 - Y0) / s.TY * s.d);
    // WebGL2 texture storage cannot change size: a canvas of a new size needs a new texture
    const size = overlay.canvas.width + "x" + overlay.canvas.height;
    if (s.ovSize !== size) {
      s.ovTex.dispose(); s.ovTex = s.ovTex.clone(); s.ov.material.map = s.ovTex; s.ov.material.needsUpdate = true; s.ovSize = size;
    }
    // mipmaps keep far, tilted parts of the overlay from shimmering into noise
    s.ovTex.magFilter = level === "text" ? THREE.LinearFilter : THREE.NearestFilter; s.ovTex.generateMipmaps = true; s.ovTex.minFilter = THREE.LinearMipmapLinearFilter; s.ovTex.anisotropy = renderer.capabilities.getMaxAnisotropy(); s.ovTex.needsUpdate = true;
    s.ov.visible = true; dirty = true;
  }

  // read one page of a surface (a live view for RAM)
  const readPage = (s, page) => page >= s.pages ? null : s.kind === "ram" ? fc.viewRam(page * PAGE, PAGE) : fc.readSd(page * PAGE, Math.min(PAGE, fc.sdBytes() - page * PAGE));
  const latent = (s, addr) => s.kind === "ram" && fc.ecc.on ? fc.latentMask(addr) : 0;
  const damagedMask = (s, addr) => s.kind === "sd" ? fc.sd.diffs.get(addr) || 0 : 0;

  function drawOverlay(s, level, X0, Y0, X1, Y1) {
    const cv = overlay.canvas, now = performance.now();
    const key = `${s.kind}:${level}:${X0}:${Y0}:${X1}:${Y1}`;
    const keep = overlay.prev && overlay.prev.key === key;
    if (level === "bytes") {
      // one texel per byte (or per few bytes when the view is wide), tinted by owner and shaded by value
      const nbx = (X1 - X0) / 8, H = Y1 - Y0, sx = Math.ceil(nbx / 1024), sy = Math.ceil(H / 1024);
      const W = Math.ceil(nbx / sx), Hc = Math.ceil(H / sy); cv.width = W; cv.height = Hc;
      const g = cv.getContext("2d"), img = g.createImageData(W, Hc), d = img.data;
      for (let yy = 0; yy < Hc; yy++) {
        const Y = Y0 + yy * sy, row = (Y % PY) * 16;
        for (let xx = 0; xx < W; xx++) {
          const X = X0 + xx * sx * 8, pcol = Math.floor(X / PX), page = Math.floor(Y / PY) * s.cols + pcol;
          const data = readPage(s, page), tint = RGB[pageCat(s, page)] || RGB.other, bi = row + ((X % PX) >> 3);
          const v = data && bi < data.length ? data[bi] : 0, i = (yy * W + xx) * 4;
          // keep the owner's colour readable: the value only shades it a little
          const k = data ? 0.62 + 0.38 * v / 255 : 0.05;
          d[i] = Math.min(255, tint[0] * k); d[i + 1] = Math.min(255, tint[1] * k); d[i + 2] = Math.min(255, tint[2] * k); d[i + 3] = 255;
          if (damagedMask(s, page * PAGE + bi) || latent(s, page * PAGE + bi)) { d[i] = 255; d[i + 1] = 60; d[i + 2] = 200; }
        }
      }
      g.putImageData(img, 0, 0); overlay.prev = null;
      return;
    }
    // bits: snapshot the bytes in view, to flash the bits that change
    const B0 = X0 >> 3, B1 = (X1 + 7) >> 3, nb = B1 - B0, H = Y1 - Y0;
    const snap = new Uint8Array(nb * H), own = new Array(nb * H);
    for (let Y = Y0; Y < Y1; Y++) {
      for (let b = B0; b < B1; ) {
        const pcol = Math.floor(b / 16), page = Math.floor(Y / PY) * s.cols + pcol, data = readPage(s, page), cat = pageCat(s, page);
        const end = Math.min(B1, (pcol + 1) * 16);
        for (; b < end; b++) { const bi = (Y % PY) * 16 + (b % 16), j = (Y - Y0) * nb + (b - B0); snap[j] = data && bi < data.length ? data[bi] : 0; own[j] = data ? cat : null; }
      }
    }
    if (keep) for (let j = 0; j < snap.length; j++) { const x = snap[j] ^ overlay.prev.snap[j]; if (x) for (let k = 0; k < 8; k++) if (x & (1 << k)) overlay.changed.set(`${s.kind}:${addrOf(s, B0 + j % nb, Y0 + Math.floor(j / nb))}:${k}`, now); }
    overlay.prev = { key, snap };
    for (const [k, t] of overlay.changed) if (now - t > 600) overlay.changed.delete(k);
    for (const [k, t] of overlay.hits) if (now - t > 4000) overlay.hits.delete(k);
    const W = X1 - X0;
    if (level === "bits") {
      cv.width = W; cv.height = H;
      const g = cv.getContext("2d"), img = g.createImageData(W, H), d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const X = X0 + x, b = X >> 3, j = y * nb + (b - B0), bit = 7 - (X & 7), cat = own[j];
        const addr = addrOf(s, b, Y0 + y), on = (snap[j] >> bit) & 1, i = (y * W + x) * 4;
        let col = cat === null ? [10, 12, 16] : on ? (ON_BIT[cat] || RGB[cat] || RGB.other) : [13, 17, 23];
        if (((latent(s, addr) | damagedMask(s, addr)) >> bit) & 1) col = [255, 60, 200];
        else if (overlay.changed.has(`${s.kind}:${addr}:${bit}`)) col = [227, 179, 65];
        if (overlay.hits.has(`${s.kind}:${addr}:${bit}`)) col = [248, 81, 73];
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return;
    }
    // text: 0s and 1s, byte and ECC-word dividers, page edges
    const cell = Math.max(10, Math.min(26, Math.floor(2600 / Math.max(W, H))));
    cv.width = W * cell; cv.height = H * cell;
    const g = cv.getContext("2d");
    g.fillStyle = "#0a0d12"; g.fillRect(0, 0, cv.width, cv.height);
    g.font = `600 ${Math.round(cell * 0.72)}px ui-monospace, Menlo, Consolas, monospace`; g.textAlign = "center"; g.textBaseline = "middle";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const X = X0 + x, b = X >> 3, j = y * nb + (b - B0), bit = 7 - (X & 7), cat = own[j];
      if (cat === null) continue;
      const addr = addrOf(s, b, Y0 + y), on = (snap[j] >> bit) & 1;
      const hidden = ((latent(s, addr) | damagedMask(s, addr)) >> bit) & 1;
      const chg = overlay.changed.has(`${s.kind}:${addr}:${bit}`), hit = overlay.hits.has(`${s.kind}:${addr}:${bit}`);
      const tint = ON_BIT[cat] || RGB[cat] || RGB.other;
      g.fillStyle = hidden ? "#5a1748" : chg ? "#e3b341" : on ? `rgb(${tint.map((v) => Math.round(v * 0.55)).join(",")})` : "#11161d";
      g.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
      g.fillStyle = hidden ? "#ff7ad9" : chg ? "#0d1117" : on ? "#f0f6fc" : "#56606c";
      // a cell the ECC is hiding shows what is really stored in it
      g.fillText(String(hidden ? on ^ 1 : on), x * cell + cell / 2, y * cell + cell / 2 + 1);
      if (hit) { g.strokeStyle = "#f85149"; g.lineWidth = Math.max(2, cell / 8); g.strokeRect(x * cell + 1.5, y * cell + 1.5, cell - 3, cell - 3); }
    }
    // dividers: every byte (thin), every 8-byte ECC word (bright), every page (strong)
    for (let x = 0; x <= W; x++) {
      const X = X0 + x; if (X % 8) continue;
      g.fillStyle = X % PX === 0 ? "#8b949e" : s.kind === "ram" && X % (WORD * 8) === 0 ? "#3d5a80" : "#262c36";
      g.fillRect(x * cell - (X % PX === 0 ? 2 : 1), 0, X % PX === 0 ? 4 : X % 64 === 0 ? 3 : 2, cv.height);
    }
    for (let y = 0; y <= H; y++) if ((Y0 + y) % PY === 0) { g.fillStyle = "#8b949e"; g.fillRect(0, y * cell - 2, cv.width, 4); }
  }
  const addrOf = (s, byteCol, Y) => (Math.floor(Y / PY) * s.cols + Math.floor(byteCol / 16)) * PAGE + (Y % PY) * 16 + (byteCol % 16);

  // ---- picking ----
  // a particle passes through the point you aim at, arriving from the upper left of your view:
  // the angle it meets the chip at follows how you hold the satellite, and its track is visible
  function beamDir() {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    return ray.ray.direction.clone().addScaledVector(up, -0.55).addScaledVector(right, 0.4).normalize();
  }
  function pickAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // from outside, the hull is in the way
    const hit = ray.intersectObjects(pickables, false)[0];
    if (!hit && xray < 0.5) { const h = ray.intersectObjects(hullMeshes, false)[0]; if (h) return { kind: "hull", point: h.point }; }
    if (!hit) return null;
    const m = hit.object, kind = m.userData.kind, s = m.userData.surface;
    if (!s || !hit.face || hit.face.normal.y < 0.5) return { kind, point: hit.point };
    const X = hit.uv.x * s.TX, Y = (1 - hit.uv.y) * s.TY;
    return { kind, s, X, Y, point: hit.point, ...s.at(X, Y) };
  }
  function describe(p) {
    if (!p) return "";
    if (p.s) {
      const ram_ = p.s.kind === "ram";
      const w = ram_ ? fc.describe(p.addr) : fc.describeSd(p.addr);
      if (p.page >= p.s.pages) return `${ram_ ? "RAM" : "SD card"}: unused`;
      const v = ram_ ? fc.readRam(p.addr, 1) : fc.readSd(p.addr, 1);
      const hidden = (latent(p.s, p.addr) >> p.bit) & 1;
      const val = v ? ` · byte 0x${hex2(v[0])}, bit ${p.bit} = ${hidden ? `${((v[0] >> p.bit) & 1) ^ 1} in the cell, ECC reads it as ${(v[0] >> p.bit) & 1}` : (v[0] >> p.bit) & 1}` : "";
      return `${ram_ ? "RAM" : "SD card"} ${hexAddr(p.addr)}${val} · ${w.label}${ram_ && w.va != null ? ` · va 0x${w.va.toString(16)}` : ""}`;
    }
    if (p.kind === "cpu") return "CPU: registers and caches are not modelled, hits here have no effect";
    if (p.kind === "fram") return `FRAM boot record: boot #${fc.fram.boots}, failed boots in a row ${fc.fram.failedStreak}, last reset: ${fc.fram.lastReset}. Ferroelectric cells: immune to bit flips`;
    if (p.kind === "wdt") return "Watchdog chip: radiation-hardened in this model, hits have no effect";
    if (p.kind === "hull") return "CubeSat hull · zoom in through it to aim at the memory";
    return "circuit board";
  }

  // ---- strikes ----
  const beams = [];
  // a beam drawn along the particle's real direction, ending where it enters the chip
  function showBeam(point, dir, len) {
    const d = camera.position.distanceTo(point);
    len = len || d * 0.7;
    const from = point.clone().addScaledVector(new THREE.Vector3(dir.x, dir.y, dir.z), -len);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, point]), new THREE.LineBasicMaterial({ color: 0xff5a4f, transparent: true, depthTest: false }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(Math.min(d, len * 2) * 0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, depthTest: false }));
    line.renderOrder = glow.renderOrder = 20; glow.position.copy(point);
    scene.add(line, glow); beams.push({ line, glow, t0: performance.now() }); dirty = true;
  }
  const DOWN = { x: 0, y: -1, z: 0 };
  const angleOf = (dir) => Math.round(Math.acos(Math.min(1, -dir.y)) * 180 / Math.PI);
  // One or more particle tracks through a surface, applied as one event.
  // kind: light | heavy | iron (one particle along dir) or flare (a burst of 48 from random directions)
  function strike(s, X, Y, kind = particle(), dir = DOWN, { quiet = false } = {}) {
    const tracks = [];
    if (kind === "flare") {
      const R = PX * 3;
      for (let i = 0; i < 48; i++) tracks.push({ X: X + (Math.random() * 2 - 1) * R, Y: Y + (Math.random() * 2 - 1) * R, dir: randomDirection(), let: PARTICLES[randomParticle()].let * 1.5 });
    } else tracks.push({ X, Y, dir, let: PARTICLES[kind] ? PARTICLES[kind].let : 0 });
    const bytes = new Map(), now = performance.now();
    let cells = 0;
    // "bit": an idealised particle that flips exactly the one cell it is aimed at
    const cellsOf = (t) => (kind === "bit" ? [{ X: Math.floor(t.X), Y: Math.floor(t.Y) }] : track(t.X, t.Y, t.dir, t.let));
    for (const t of tracks) for (const c of cellsOf(t)) {
      if (c.X < 0 || c.Y < 0 || c.X >= s.TX || c.Y >= s.TY) continue;
      const a = s.at(c.X, c.Y); if (a.page >= s.pages) continue;
      bytes.set(a.addr, (bytes.get(a.addr) || 0) | (1 << a.bit)); cells++;
      overlay.hits.set(`${s.kind}:${a.addr}:${a.bit}`, now);
    }
    const list = [...bytes].map(([addr, mask]) => (s.kind === "ram" ? { pa: addr, mask } : { index: addr, mask }));
    const result = !list.length ? { none: true } : s.kind === "ram" ? fc.hitRamMany(list, { quiet }) : fc.hitSdMany(list, { quiet });
    if (!quiet || overlay.level !== "none" || dist() > 1.5) showBeam(s.mesh.localToWorld(s.local(X, Y)), toWorldDir(kind === "flare" ? DOWN : dir), quiet ? 3 : 0);
    if (result && result.none && !quiet) fc.log(`${PARTICLES[kind] ? PARTICLES[kind].label : "burst"} at ${angleOf(dir)}° from vertical passed through without flipping anything (too little charge per cell)`);
    redrawSoon();
    const { addr, bit } = s.at(X, Y);
    if (!quiet && onStrike) onStrike({ surface: s.kind, addr, bit, kind, angle: angleOf(dir), cells, result });
    return result;
  }
  const redrawSoon = () => { overlay.prev = overlay.prev && { ...overlay.prev }; overlayDue = true; };
  // background radiation: a particle at a random point of the board, from a random direction
  const surfaceAt = (x, z) => {
    for (const s of [ram, sd]) { const p = s.mesh.position; if (Math.abs(x - p.x) <= s.w / 2 && Math.abs(z - p.z) <= s.d / 2) return { s, X: (x - p.x + s.w / 2) / s.w * s.TX, Y: (z - p.z + s.d / 2) / s.d * s.TY }; }
    return null;
  };
  function randomStrike(kind, dir) {
    const x = (Math.random() - 0.5) * 9, z = (Math.random() - 0.5) * 6.6, hit = surfaceAt(x, z);
    if (!hit) { if (overlay.level === "none") showBeam(group.localToWorld(new THREE.Vector3(x, 0.08, z)), toWorldDir(dir), 3); return { surface: "board" }; }
    // NAND flash cells hold far more charge than DRAM cells, and the card's controller has
    // its own ECC: only a small share of the particles that reach it leave damage behind
    if (hit.s.kind === "sd" && Math.random() > SD_DAMAGE_SHARE) { if (overlay.level === "none") showBeam(hit.s.mesh.localToWorld(hit.s.local(hit.X, hit.Y)), toWorldDir(dir), 3); return { surface: "sd", harmless: true }; }
    strike(hit.s, hit.X, hit.Y, kind, dir, { quiet: true });
    return { surface: hit.s.kind };
  }

  // ---- input: tap/click fires along the line of sight, drag orbits, wheel/pinch zooms ----
  let down = null;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  el.addEventListener("pointerup", (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 600) {
      const p = pickAt(e.clientX, e.clientY), dir = beamDir();
      if (p && p.s && p.page < p.s.pages) strike(p.s, p.X, p.Y, particle(), toLocalDir(dir));
      else if (p) { if (p.point) showBeam(p.point, dir); onStrike && onStrike({ surface: p.kind, info: describe(p) }); }
    }
    down = null;
  });
  let hoverText = "";
  el.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && !e.buttons) hoverText = describe(pickAt(e.clientX, e.clientY)); });
  el.addEventListener("pointerleave", () => { hoverText = ""; });

  new ResizeObserver(resize).observe(host); resize();

  const dist = () => camera.position.distanceTo(controls.target);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let xray = 0, tumble = 0, last = performance.now(), sliding = false, stage = "", mapMode = null;
  // the zoom slider is the camera distance on a log scale
  const MIN_D = controls.minDistance;
  const toSlider = (d) => Math.log(MAX_D / d) / Math.log(MAX_D / MIN_D), fromSlider = (v) => MAX_D * Math.pow(MIN_D / MAX_D, v);
  // where each stage starts, for the slider's tick marks
  const pageW = ram.w / ram.cols * S, H0 = () => renderer.domElement.clientHeight || 800, tanH = () => Math.tan(camera.fov * Math.PI / 360);
  const STAGES = [
    { name: "ORBIT", d: () => homePose().dist }, { name: "COMPUTER", d: () => 1.1 }, { name: "MEMORY", d: () => 0.36 },
    { name: "BYTES", d: () => pageW * H0() / (48 * 2 * tanH()) }, { name: "BITS", d: () => MIN_D },
  ];
  placeTicks = function () { if (ticks) STAGES.forEach((st, i) => { if (ticks[i]) ticks[i].style.left = (Math.max(0, Math.min(1, toSlider(st.d()))) * 100) + "%"; }); }
  if (zoomInput) {
    zoomInput.addEventListener("pointerdown", () => { sliding = true; controls.autoRotate = false; flight = null; });
    addEventListener("pointerup", () => { sliding = false; });
    zoomInput.addEventListener("input", () => { const d = fromSlider(zoomInput.value / 1000), dir = camera.position.clone().sub(controls.target).normalize(); camera.position.copy(controls.target).addScaledVector(dir, d); controls.autoRotate = false; moved = true; overlayDue = true; dirty = true; });
  }
  addEventListener("resize", placeTicks); setTimeout(placeTicks, 0);
  // magnet: once inside the satellite, pull the view onto a memory chip, then leave it where you put it.
  //  - the middle of the screen is over a chip: stay exactly there
  //  - it has slipped off a chip: ease back just inside the nearest edge
  //  - no chip in view yet (coming in from outside): head for the nearer chip
  function magnet(d) {
    if (flight || d > 1.0 || d < 0.03) return;
    ndc.set(0, 0); ray.setFromCamera(ndc, camera);
    const under = ray.intersectObjects([ram.mesh, sd.mesh], false)[0];
    if (under && under.face && under.face.normal.y > 0.5) {
      // settle the pivot onto the chip surface along the line of sight: the picture does not move,
      // but turning, panning and zooming now happen about the memory you are looking at
      controls.target.lerp(under.point, 0.18);
      return;
    }
    let s = null, bestD = Infinity;
    for (const x of [ram, sd]) { const dd = ray.ray.distanceSqToPoint(x.mesh.localToWorld(new THREE.Vector3(0, x.h / 2, 0))); if (dd < bestD) { bestD = dd; s = x; } }
    const l = s.mesh.worldToLocal(controls.target.clone()), m = 0.47;
    const inX = Math.abs(l.x) <= s.w / 2 && Math.abs(l.z) <= s.d / 2;
    // far off the chip: go for its middle; just off an edge: step back over the edge
    const far = Math.abs(l.x) > s.w || Math.abs(l.z) > s.d;
    const gx = far ? 0 : Math.max(-s.w * m, Math.min(s.w * m, l.x)), gz = far ? 0 : Math.max(-s.d * m, Math.min(s.d * m, l.z));
    if (inX && !far && Math.abs(l.y - s.h / 2) < s.h) return;
    const goal = s.mesh.localToWorld(new THREE.Vector3(gx, s.h / 2, gz));
    const shift = goal.sub(controls.target).multiplyScalar((1 - smooth(0.3, 1.0, d)) * 0.18);
    controls.target.add(shift); camera.position.add(shift);
  }
  // up close, look down onto the board: tilting stays possible, up to about 50° from vertical
  function lookDown(d) {
    // the deeper you go, the more from above: about 50° at the chip, 30° at the bits
    const k = 1 - smooth(0.4, 1.1, d), deep = 1 - smooth(0.004, 0.05, d), limit = Math.PI * (1 - k) + (0.88 - 0.36 * deep) * k;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(group.getWorldQuaternion(tmpQ));
    const off = camera.position.clone().sub(controls.target), phi = Math.acos(Math.max(-1, Math.min(1, off.clone().normalize().dot(up))));
    if (phi > limit) { const axis = up.clone().cross(off).normalize(); off.applyAxisAngle(axis, -Math.min(phi - limit, 0.05)); camera.position.copy(controls.target).add(off); }
  }
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    stepFlight(now);
    let d = dist();
    // inside the satellite the controls work like a map: drag moves across the board, two fingers
    // (or the right mouse button) tilt. Outside, drag turns the satellite. Never switch mid-gesture.
    const inside = d < 0.6;
    if (!touching && inside !== mapMode) {
      mapMode = inside;
      controls.mouseButtons = inside ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.touches = inside ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      // pan across the board's plane, so the view stays on the chip surface
      controls.screenSpacePanning = !inside;
      if (hintEl) hintEl.textContent = inside ? (matchMedia("(pointer: coarse)").matches ? "DRAG TO MOVE · TWO FINGERS TO ZOOM AND TILT · TAP TO FIRE" : "DRAG TO MOVE · RIGHT-DRAG TO TILT · SCROLL TO ZOOM · CLICK TO FIRE") : (matchMedia("(pointer: coarse)").matches ? "DRAG TO TURN · PINCH TO ZOOM IN" : "DRAG TO TURN · SCROLL TO ZOOM IN");
    }
    // the magnet only acts once you let go, so it never fights your hand
    if (!sliding && !touching) magnet(d);
    if (!sliding) lookDown(d);
    d = dist();
    // the satellite drifts gently while you look at it from outside
    if (d > 2.5 && !reduce && !flight) { tumble += dt; sat.rotation.x = Math.sin(tumble * 0.13) * 0.08; sat.rotation.z = Math.cos(tumble * 0.11) * 0.06; dirty = true; }
    // closer in, the hull turns to x-ray so you can see inside
    const xr = 1 - smooth(1.1, 1.9, d);
    if (Math.abs(xr - xray) > 1e-3) { xray = xr; for (const mat of hullMats) { mat.opacity = mat.userData.base * (1 - xray * 0.92); mat.depthWrite = mat.userData.depth && xray < 0.5; } edges.material.opacity = 0.25 + xray * 0.45; dirty = true; }
    camera.near = Math.max(1e-6, d * 0.01); camera.updateProjectionMatrix();
    if (zoomInput && !sliding) { zoomInput.value = Math.round(Math.max(0, Math.min(1, toSlider(d))) * 1000); zoomInput.style.setProperty("--z", zoomInput.value / 10 + "%"); }
    const st = overlay.level === "text" || overlay.level === "bits" ? 4 : overlay.level === "bytes" ? 3 : d > 2.2 ? 0 : d > 0.6 ? 1 : 2;
    if (STAGES[st].name !== stage) { stage = STAGES[st].name; if (ticks) ticks.forEach((t, i) => t.classList.toggle("on", i === st)); if (zoomInput) zoomInput.setAttribute("aria-valuetext", stage); if (stageEl) stageEl.textContent = stage; }
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i], a = 1 - (now - b.t0) / 700;
      if (a <= 0) { scene.remove(b.line, b.glow); b.line.geometry.dispose(); b.glow.geometry.dispose(); beams.splice(i, 1); continue; }
      b.line.material.opacity = a; b.glow.material.opacity = a; b.glow.scale.setScalar(1 + (1 - a) * 3);
    }
    if (overlayDue && now - lastOverlay > 70) updateOverlay();
    if (controls.update() || beams.length || dirty || controls.autoRotate) { renderer.render(scene, camera); dirty = false; }
  }
  requestAnimationFrame(animate);
  // the data under the overlay keeps changing: re-read it a few times a second
  setInterval(() => { if (overlay.level !== "none" && document.visibilityState === "visible") overlayDue = true; }, 250);

  return {
    flyTo, home, zoomBy, strike, describe, pickAt,
    surfaces: { ram, sd },
    get level() { return overlay.level; },
    get stage() { return stage; },
    get hover() { return hoverText; },
    // what is at the centre of the screen (for the "you are here" line when zoomed)
    center() {
      const r = el.getBoundingClientRect(); const p = pickAt(r.left + r.width / 2, r.top + r.height / 2);
      return p && p.s ? describe(p) : "";
    },
    // for tests: fire at an address (RAM or SD) and bit; dir in chip axes, default straight down
    strikeAt(kind, addr, bit = 0, particleKind = "bit", dir = DOWN) { const s = kind === "sd" ? sd : ram, { X, Y } = s.xy(addr, bit); return strike(s, X, Y, particleKind, dir); },
    randomStrike,
    onMap: () => drawBase(ram), onSd: refreshSd, redraw,
    _cam: () => ({ t: controls.target.toArray().map((v) => +v.toFixed(5)), c: camera.position.toArray().map((v) => +v.toFixed(5)), auto: controls.autoRotate, sat: [sat.rotation.x, sat.rotation.z].map((v) => +v.toFixed(4)) }),
    _debug: () => { const r = overlay.region; return r && { kind: r.s.kind, X0: r.X0, Y0: r.Y0, X1: r.X1, Y1: r.Y1, level: overlay.level, canvas: [overlay.canvas.width, overlay.canvas.height], start: r.s.at(r.X0, r.Y0), dist: camera.position.distanceTo(controls.target), png: overlay.canvas.toDataURL() }; },
  };
}
