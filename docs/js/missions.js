// Guided missions: each one sets up the protections, gives a goal, and ticks the
// goals off by itself from what the hardware and flight software report.
import { bus } from "./util.js";
import { calcOk } from "./os/linux-cfs.js";

const used = (h) => h.what && h.what.cat !== "free";
const MISSIONS = [
  {
    id: "break", title: "1. Break it",
    setup: { ecc: false, watchdog: false, tmr: true, particle: "flare", bg: false },
    intro: "No protection at all. Fire at the memory the flight software uses until it goes down.",
    hint: "Blue and green pages on the RAM chip belong to cFS and its apps. A flare burst sends 48 particles at once; zoom in on a blue page to aim at code.",
    goals: [
      { text: "Hit memory the flight software uses", on: { "ram-hit": (e) => used(e) } },
      { text: "The flight software goes down", on: { "fsw-down": () => true, state: (e) => e.state === "hung" } },
    ],
    why: "cFS runs all of its apps as threads of one Linux process, so they share one address space: a flipped bit in any app, or in cFS itself, can take all of them down, Health & Safety included. With no watchdog nothing on board notices; the satellite stays silent until the ground power-cycles it.",
  },
  {
    id: "watchdog", title: "2. Let the watchdog recover it",
    setup: { ecc: false, watchdog: true, tmr: true, particle: "flare", bg: false },
    intro: "Same attack, but now the hardware watchdog is connected. Crash the flight software and watch it come back on its own.",
    hint: "Health & Safety kicks the watchdog every second while cFS is running. When the kicks stop, the chip waits 10 seconds and then resets the whole computer.",
    goals: [
      { text: "Crash the flight software", on: { "fsw-down": () => true, state: (e) => e.state === "hung" } },
      { text: "The watchdog resets the computer", after: 0, on: { reset: (e) => e.reason === "watchdog" } },
      { text: "The flight software is back", after: 1, on: { state: (e) => e.state === "operational" } },
    ],
    why: "A watchdog turns a hang or a crash into a reboot, which is the cheapest repair there is. It costs time (about half a minute here) and everything in RAM: watch the calculator start again from step 1. The FRAM boot record keeps counting resets, because FRAM survives both the reset and radiation.",
  },
  {
    id: "ecc", title: "3. ECC: one bit is free",
    setup: { ecc: true, watchdog: true, tmr: true, particle: "bit", bg: false },
    intro: "The memory controller now keeps 8 check bits for every 8 bytes (SECDED). Hit RAM with single-bit particles, then zoom in to see what ECC is hiding.",
    hint: "Zoom all the way in on the spot you hit: the flipped cell shows in pink. Software still reads the right value, because the controller corrects every read. The scrubber passes every 20 s and rewrites the word.",
    goals: [
      { text: "Land a single-bit hit that ECC corrects", on: { "ram-hit": (e) => e.outcome === "corrected" } },
      { text: "Zoom in to the bits while ECC is hiding an error", after: 0, on: { zoom: (e) => e.level === "text" && e.fc.ecc.latent.size > 0 } },
      { text: "The scrubber (or a software write) clears it", after: 0, on: { scrub: (e) => e.fixed > 0, "ecc-overwritten": () => true } },
    ],
    why: "A single-bit error costs nothing: no crash, no reboot, software never notices. The catch is time: the flipped cell stays flipped until the scrubber or a write replaces the word, and a second hit in the same word before then is no longer a single-bit error.",
  },
  {
    id: "ecc-limit", title: "4. Where ECC gives up",
    setup: { ecc: true, watchdog: true, tmr: true, particle: "heavy", bg: false },
    intro: "A heavy ion coming in at a low angle flips a line of cells. Along a row the line stays inside one 8-byte word; across rows every cell lands in a different word. Same particle, very different outcome.",
    hint: "The particle flies along your line of sight. Zoom in on memory the flight software uses (blue or green) until you see bits, then drag the board so you look along the rows (from the left or right) and fire. Then turn it so you look along the columns (from the front or back) and fire again. The blue lines mark the 8-byte ECC words.",
    goals: [
      { text: "Low-angle hit along a row: bits in one word, machine check", on: { "ram-hit": (e) => e.outcome === "machine-check" } },
      { text: "Low-angle hit across rows: several bits, every one corrected", on: { "ram-hit": (e) => e.outcome === "corrected" && e.words >= 2 } },
      { text: "Bonus: 3 bits in one word, silently miscorrected", optional: true, on: { "ram-hit": (e) => e.outcome === "silent" } },
    ],
    why: "SECDED corrects one bit per word and detects two. Three or more can look like one, so the decoder \"fixes\" the wrong bit: of all 41,664 ways to flip 3 bits of a 64-bit word, 76% end up silently wrong in this code. That is why real memory interleaves: it stores physically neighbouring cells in different words, so a line of upsets from one particle turns into single-bit errors ECC can fix. Turning the board did exactly that. Scrubbing often keeps single errors from piling up in one word.",
  },
  {
    id: "tmr", title: "5. Software TMR: repair without a reboot",
    setup: { ecc: false, watchdog: true, tmr: true, particle: "bit", bg: false },
    intro: "The calculator app adds 1, 2, 3, … once a second, so its sum must be step × (step + 1) / 2. It keeps its state in three copies and votes every cycle. ECC is off so the hits get through.",
    hint: "Use the copy buttons in the calculator panel to fly to a copy, then click a bit of its first 8 bytes (step and sum). Then turn Software TMR off and do it again.",
    zoomButtons: true,
    goals: [
      { text: "Flip a bit in one of the three copies", on: { "ram-hit": (e) => /^tmr/.test(e.what.cat || "") && e.outcome === "landed" } },
      { text: "The vote repairs it, no reboot", after: 0, on: { "tmr-repair": (e) => true } },
      { text: "With TMR off, a hit makes the answer wrong", on: { "calc-wrong": (e) => !e.calc.on } },
    ],
    why: "Voting fixes the data the moment it is used, without losing a second of service. It costs three times the memory and the work, and it only protects what is kept in TMR (the rest of the app, cFS and the kernel are still single copies). If two copies get the same bit flipped, they outvote the good one.",
  },
  {
    id: "sd", title: "6. Damage that waits on the SD card",
    setup: { ecc: true, watchdog: true, tmr: true, particle: "bit", bg: false },
    intro: "The SD card holds the kernel and the flight software that every boot loads. Hit the flight software executable there.",
    hint: "On the SD card chip, blue is the cFS executable (core-cpu1). Nothing happens when you hit it: the running copy is in RAM. Then power-cycle.",
    goals: [
      { text: "Hit the cFS executable on the SD card", on: { "sd-hit": (e) => e.what.cat === "fsw" } },
      { text: "Power cycle: the flight software cannot start", after: 0, on: { state: (e) => e.state === "badimage" } },
      { text: "Boot loop: FRAM counts 2 failed boots", after: 1, on: { reset: (e) => e.fc.fram.failedStreak >= 2 } },
      { text: "Restore the SD card: the next reset boots clean", after: 2, needs: "sd-restore", on: { state: (e) => e.state === "operational" } },
    ],
    why: "Storage damage is latent: it does nothing until the next boot reads it, possibly months later, and then every boot fails the same way. The watchdog just keeps rebooting into the same broken file. FRAM keeps the count of failed boots, which is what a real boot loader uses to fall back to a golden image; here the ground re-uploads the image instead.",
  },
  {
    id: "orbit", title: "7. Survive in orbit",
    setup: { ecc: true, watchdog: true, tmr: true, particle: "heavy", bg: true, env: "flare", warp: 86400 },
    intro: "Background radiation on: particles arrive from random directions at the rate of a solar particle event, sped up so a day passes every second. See how the computer holds up, then try other protection settings.",
    hint: "Reset the stats before each run so the numbers compare. Try everything off, ECC only, and everything on. The stress test is far beyond real rates: it shows what each layer does when it is overwhelmed.",
    goals: [
      { text: "Run 7 mission days under background radiation", on: { "bg-progress": (e) => e.stats.missionS >= 7 * 86400 } },
      { text: "…with the flight software up at least 95% of the time", after: 0, on: { "bg-progress": (e) => e.stats.missionS >= 7 * 86400 && e.stats.upS / e.stats.realS >= 0.95 } },
      { text: "Bonus: run the stress test until something gets through", optional: true, on: { reset: (e) => window.sim && window.sim.bg.on && window.sim.bg.env === "stress", "fsw-down": () => window.sim && window.sim.bg.on && window.sim.bg.env === "stress" } },
    ],
    why: "In orbit, faults are random in place, time and direction. Most particles land in free memory or flip nothing; what matters is the rare heavy ion at a low angle, or a hit on something the software is using right now. The protections stack: ECC removes nearly all single-bit errors, TMR keeps one critical calculation right without a reboot, and the watchdog turns whatever still gets through into a reboot instead of a dead satellite. Uptime shows what each layer is worth. The rates here are illustrative orders of magnitude, sped up; the software itself runs in real time, so a reboot still takes half a minute.",
  },
];

export function createMissions({ el, fc, apply, zoomToCopy }) {
  let done = {};
  try { done = JSON.parse(localStorage.getItem("missions") || "{}"); } catch (e) { done = {}; }
  const save = () => { try { localStorage.setItem("missions", JSON.stringify(done)); } catch (e) { /* private mode */ } };
  let open = (MISSIONS.find((m) => !isComplete(m)) || MISSIONS[0]).id;
  const seen = new Set();   // "needs" events seen since a mission's previous goal

  function isComplete(m) { const d = done[m.id] || []; return m.goals.every((g, i) => g.optional || d[i]); }
  function render() {
    el.innerHTML = `<h2>Missions</h2><p class="dim">Pick one; its setup button sets the protections. Goals tick themselves off.</p>` + MISSIONS.map((m) => {
      const d = done[m.id] || [], complete = isComplete(m), isOpen = m.id === open;
      return `<section class="mission${isOpen ? " open" : ""}${complete ? " complete" : ""}" data-id="${m.id}">
        <button class="mhead" aria-expanded="${isOpen}"><span>${m.title}</span><span class="mstate">${complete ? "✓ done" : `${d.filter(Boolean).length}/${m.goals.filter((g) => !g.optional).length}`}</span></button>
        ${isOpen ? `<div class="mbody">
          <p>${m.intro}</p>
          <button class="setup">Set up: ECC ${m.setup.ecc ? "on" : "off"}, watchdog ${m.setup.watchdog ? "on" : "off"}, TMR ${m.setup.tmr ? "on" : "off"}, ${{ bit: "single-bit", light: "light-ion", heavy: "heavy-ion", flare: "flare-burst" }[m.setup.particle]} particles${m.setup.bg ? ", background radiation on" : ""}</button>
          ${m.zoomButtons ? `<div class="row">Fly to: <button data-copy="1">copy 1</button><button data-copy="2">copy 2</button><button data-copy="3">copy 3</button></div>` : ""}
          <ul class="goals">${m.goals.map((g, i) => `<li class="${d[i] ? "met" : ""}${g.optional ? " opt" : ""}"><span class="box">${d[i] ? "✓" : ""}</span>${g.text}</li>`).join("")}</ul>
          <details class="hint"><summary>Hint</summary><p>${m.hint}</p></details>
          <details class="why"${complete ? " open" : ""}><summary>Why it works this way</summary><p>${m.why}</p></details>
        </div>` : ""}
      </section>`;
    }).join("") + `<button class="reset-progress">Reset progress</button>`;
  }
  el.addEventListener("click", (e) => {
    const sec = e.target.closest(".mission");
    if (e.target.closest(".mhead")) { open = open === sec.dataset.id ? null : sec.dataset.id; render(); return; }
    if (e.target.closest(".setup")) { const m = MISSIONS.find((x) => x.id === sec.dataset.id); apply(m.setup); return; }
    const copy = e.target.closest("[data-copy]"); if (copy) { zoomToCopy(+copy.dataset.copy); return; }
    if (e.target.closest(".reset-progress")) { done = {}; save(); seen.clear(); render(); }
  });

  bus.on("*", (e) => {
    if (e.type === "log" || e.type === "console" || e.type === "telemetry") return;
    const m = MISSIONS.find((x) => x.id === open); if (!m) return;
    if (e.type === "sd-restore") seen.add(m.id + ":sd-restore");
    const d = done[m.id] || (done[m.id] = []);
    let changed = false;
    m.goals.forEach((g, i) => {
      if (d[i] || !g.on[e.type]) return;
      if (g.after !== undefined && !d[g.after]) return;
      if (g.needs && !seen.has(m.id + ":" + g.needs)) return;
      if (g.on[e.type](e)) { d[i] = true; changed = true; }
    });
    if (changed) { save(); render(); }
  });
  render();
  return { get open() { return open; }, select(id) { open = id; render(); }, done: () => done, list: MISSIONS };
}

export { calcOk };
