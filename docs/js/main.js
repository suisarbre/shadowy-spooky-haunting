// Wires the page together: one flight computer, its 3D board, the missions.
import { $, bus, hexAddr, loadImages } from "./util.js";
import { FlightComputer, SCRUB_MS, BOOT_WINDOW_MS } from "./hardware.js";
import { createBoard } from "./board3d.js";
import { createMissions } from "./missions.js";
import os, { commands, calcExpected, calcOk } from "./os/linux-cfs.js";   // swap the adapter to try another OS

const STATE_TEXT = {
  booting: () => `booting (boot #${fc.fram.boots})…`, bootloop: () => `BOOT LOOP (${fc.fram.failedStreak} failed boots in a row)`,
  starting: () => "starting flight software…", operational: () => "OPERATIONAL", lost: () => "telemetry lost, checking…",
  crashed: () => "flight software crashed", hung: () => "silent but alive (hung)", exited: (d) => `flight software exited (code ${d})`,
  badimage: () => "flight software cannot start (damaged file)", panic: () => "kernel panic",
};
const STATE_CLASS = { operational: "ok", booting: "", starting: "", lost: "warn", hung: "bad", crashed: "bad", exited: "bad", badimage: "bad", panic: "bad", bootloop: "bad" };
const desired = { ecc: false, watchdog: true, tmr: true, particle: "1" };
let fc, board, missions;

function setToggle(id, on, label) { const b = $(id); b.setAttribute("aria-pressed", String(on)); b.querySelector("b").textContent = on ? "ON" : "OFF"; }
function applySetup(s) {
  if (s.ecc !== undefined) { desired.ecc = s.ecc; fc.setEcc(s.ecc); }
  if (s.watchdog !== undefined) { desired.watchdog = s.watchdog; fc.setWatchdog(s.watchdog); }
  if (s.tmr !== undefined) { desired.tmr = s.tmr; if (fc.operational) fc.send(commands.calcTmr(s.tmr)); }
  if (s.particle) desired.particle = s.particle;
  renderControls();
}
function renderControls() {
  setToggle("t-ecc", desired.ecc); setToggle("t-wd", desired.watchdog); setToggle("t-tmr", desired.tmr);
  for (const b of document.querySelectorAll("#particle button")) b.setAttribute("aria-pressed", String(b.dataset.p === desired.particle));
}

function renderStatus() {
  const st = $("status"); st.textContent = (STATE_TEXT[fc.state] || (() => fc.state))(fc.stateDetail); st.className = "status " + (STATE_CLASS[fc.state] || "");
  const now = Date.now(), wd = fc.wd, since = (now - wd.lastKick) / 1000;
  const wdText = !fc.watchdogConnected ? "disconnected" : !wd.enabled ? "off" : !wd.byFsw ? `boot window ${since.toFixed(0)} / ${(BOOT_WINDOW_MS / 1000).toFixed(0)} s` : `armed, last kick ${since.toFixed(1)} s ago`;
  const e = fc.ecc, c = fc.app.calc, scrubIn = Math.max(0, Math.ceil((SCRUB_MS - (now - e.lastScrub)) / 1000));
  const rep = fc.app.lastRepair && now - fc.app.lastRepair.t < 4000 ? fc.app.lastRepair : null;
  $("facts").innerHTML = `
    <div><span class="k">Watchdog</span>${wdText}</div>
    <div><span class="k">FRAM boot record</span>boot #${fc.fram.boots} · failed in a row ${fc.fram.failedStreak} · last reset: ${fc.fram.lastReset}</div>
    <div><span class="k">ECC</span>${e.on ? `on · corrected ${e.corrected} · detected ${e.detected} · silently wrong ${e.silent} · hiding now <b class="${e.latent.size ? "pink" : ""}">${e.latent.size}</b> · next scrub in ${scrubIn} s` : "off"}</div>
    <div><span class="k">SD card</span>${fc.sdDamagedBits() ? `<b class="bad">${fc.sdDamagedBits()} bit(s) damaged</b>, takes effect at the next boot` : "matches the launch image"}</div>
    <div class="calc"><span class="k">Calculator (software TMR ${c ? (c.on ? "on" : "off") : "–"})</span>${c ? `step ${c.step} · sum ${c.sum} <b class="${calcOk(c) ? "ok" : "bad"}">${calcOk(c) ? "✓ correct" : `✗ should be ${calcExpected(c.step)}`}</b><br>
      ${c.copies.map((v, k) => `<button class="copy${rep && rep.mask & (1 << k) ? " hit" : ""}" data-copy="${k + 1}" title="Fly to copy ${k + 1}">copy ${k + 1}: ${v}${rep && rep.mask & (1 << k) ? ` (was ${rep.copies[k]}, outvoted)` : ""}${!c.on && k ? " (unused)" : ""}</button>`).join("")}
      · repaired ${c.repairs}× <button id="calc-reset">Reset</button>` : "waiting for telemetry…"}</div>`;
  $("t-tmr").disabled = !fc.operational;
  $("where").textContent = board ? (board.hover || (board.level !== "none" ? board.center() : "")) : "";
  $("zoomlevel").textContent = board ? { none: "board", bytes: "bytes (brightness = value)", bits: "bits", text: "bits: click one to flip it" }[board.level] : "";
}
function renderLog() {
  const t0 = startTime, lines = fc.events.slice(-150).map((e) => `${((e.t - t0) / 1000).toFixed(0).padStart(5)}s  ${e.line}`);
  $("evt").textContent = lines.join("\n"); $("evt").scrollTop = 1e9;
}
let logQueued = false; const logSoon = () => { if (!logQueued) { logQueued = true; setTimeout(() => { logQueued = false; renderLog(); }, 150); } };
const startTime = Date.now();

function zoomToCopy(k) {
  const run = fc.findRun(os.tmrLabel(k));
  if (!run) { $("beamlog").textContent = "The memory map has not located the TMR copies yet: wait for the flight software to come up."; return; }
  board.flyTo("ram", run.pfn * 4096, 48);
}

async function start() {
  const images = await loadImages(os);
  fc = new FlightComputer(os, images);
  fc.setWatchdog(desired.watchdog);
  board = createBoard({
    host: $("view3d"), fc, os, particle: () => desired.particle,
    onStrike(s) {
      const r = s.result;
      let text;
      if (s.info) text = s.info;
      else if (!r) text = "No power: the computer is starting up, try again in a moment.";
      else if (r.shower) text = `Shower: ${Object.entries(r.shower).map(([k, n]) => `${n} ${k}`).join(", ")}`;
      else if (s.surface === "sd") text = `SD card byte ${r.index} · ${r.what.label}: damaged, nothing happens until the next boot reads it`;
      else text = `RAM ${hexAddr(r.pa)} · ${r.what.label}: ${r.text}`;
      $("beamlog").innerHTML = "";
      $("beamlog").append(document.createTextNode(text + " "));
      if (s.addr !== undefined && board.level !== "text") {
        const b = document.createElement("button"); b.textContent = "Zoom in on it"; b.className = "link";
        b.onclick = () => board.flyTo(s.surface, s.addr); $("beamlog").append(b);
      }
    },
  });
  missions = createMissions({ el: $("missions"), fc, apply: applySetup, zoomToCopy });
  bus.on("map", () => board.onMap());
  bus.on("sd-hit", () => board.onSd()); bus.on("sd-restore", () => board.onSd());
  bus.on("reset", () => board.onMap());
  bus.on("log", logSoon);
  bus.on("state", (e) => { renderStatus(); if (e.state === "operational") setTimeout(() => fc.operational && fc.send(commands.calcTmr(desired.tmr)), 2500); });
  bus.on("console", () => { if ($("con-box").open) { $("con").textContent = fc.con; $("con").scrollTop = 1e9; } });
  bus.on("telemetry", () => { if ($("tlm-box").open) $("tlm").textContent = [...fc.tlmCounts].sort((a, b) => a[0] - b[0]).map(([m, n]) => "0x" + m.toString(16).padStart(4, "0") + "  " + n).join("\n"); });
  let lastLevel = "none";
  setInterval(() => { fc.tick(); renderStatus(); }, 1000);
  setInterval(() => { if (board.level !== lastLevel) { lastLevel = board.level; bus.emit("zoom", { fc, level: lastLevel }); } $("where").textContent = board.hover || (board.level !== "none" ? board.center() : ""); }, 300);
  setInterval(() => { if (fc.operational) fc.requestMap(); }, 15000);   // memory layout drifts as software runs
  renderControls(); renderStatus(); renderLog();
  window.sim = { fc, board, missions, applySetup, desired, calcOk, zoomToCopy, os, commands };
}

// ---- controls ----
$("t-ecc").onclick = () => applySetup({ ecc: !desired.ecc });
$("t-wd").onclick = () => applySetup({ watchdog: !desired.watchdog });
$("t-tmr").onclick = () => applySetup({ tmr: !desired.tmr });
$("particle").onclick = (e) => { const b = e.target.closest("button"); if (b) applySetup({ particle: b.dataset.p }); };
$("power").onclick = () => { fc.log("GROUND: power cycle commanded"); fc.powerCycle("ground command"); };
$("restore").onclick = () => fc.restoreSd();
$("z-home").onclick = () => board.home();
$("z-in").onclick = () => board.zoomBy(1 / 8);
$("z-out").onclick = () => board.zoomBy(8);
$("facts").addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]"); if (c) zoomToCopy(+c.dataset.copy);
  if (e.target.id === "calc-reset") fc.send(commands.calcReset());
});

start().catch((e) => { $("status").textContent = `could not load the VM images: ${e.message}`; $("status").className = "status bad"; console.error(e); });
