// The ground station panel: uplink Doom, then play it on the ground and the satellite at once.
import { $, bus } from "./util.js";
import { GroundStation, LINK_BPS } from "./ground.js";
import { DOOM_KEYS } from "./doom-ground.js";

const TICRATE = 35, MAX_AHEAD = 35;   // the ground may run up to 1 s of tics ahead of the satellite

export function createGroundUI({ fc }) {
  const gs = new GroundStation({ fc });
  const panel = $("gs"), openBtn = $("gs-open");
  let wad = null, wasm = null, uploading = false;
  const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";

  const setOpen = (on) => { panel.hidden = !on; openBtn.setAttribute("aria-expanded", String(on)); if (on) render(); };
  openBtn.onclick = () => setOpen(panel.hidden);
  $("gs-close").onclick = () => setOpen(false);

  $("gs-wad").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer()), magic = new TextDecoder().decode(bytes.subarray(0, 4));
    if (magic !== "IWAD") { $("gs-up-text").textContent = `${f.name} is not a Doom IWAD file.`; wad = null; render(); return; }
    wad = { name: f.name.toLowerCase().replace(/[^a-z0-9._-]/g, "_"), bytes };
    render();
  };

  function render() {
    const files = gs.payloadFiles();
    $("gs-files").innerHTML = files.length
      ? "On the satellite's SD card:<br>" + files.map((f) => `<b>${f.name}</b> ${kb(f.size)} compressed`).join("<br>")
      : `Nothing uplinked yet. SD card free: ${kb(fc.sdFree())}.`;
    $("gs-wad-name").textContent = wad ? `${wad.name} · ${kb(wad.bytes.length)}` : "Choose Doom game data (.wad)…";
    $("gs-up").disabled = uploading || !wad || !fc.emu;
    const ready = wad && gs.hasPayload("doom") && gs.hasPayload(wad.name);
    $("gs-start").disabled = !ready || !fc.emu || uploading;
    $("gs-stop").disabled = !gs.doom;
  }
  bus.on("sd-write", render); bus.on("sd-restore", render); bus.on("state", render);

  $("gs-up").onclick = async () => {
    if (!wad) return;
    uploading = true; render();
    const bar = $("gs-bar"), text = $("gs-up-text");
    try {
      if (!wasm) wasm = { sat: new Uint8Array(await (await fetch(`payload/doom-i386?v=${window.BUILD}`)).arrayBuffer()), ground: new Uint8Array(await (await fetch(`payload/doom-ground.wasm?v=${window.BUILD}`)).arrayBuffer()) };
      const jobs = [["doom", wasm.sat], [wad.name, wad.bytes]].filter(([n]) => !gs.hasPayload(n));
      if (!jobs.length) text.textContent = "Both files are already on the satellite.";
      for (const [name, bytes] of jobs) {
        const r = await gs.uplink(name, bytes, { onProgress: (p) => {
          bar.style.width = (100 * p.sent / p.total).toFixed(1) + "%";
          text.textContent = `${name}: ${kb(p.sent)} / ${kb(p.total)} compressed · ${kb(p.rate)}/s${p.resent ? ` · ${p.resent} chunks resent` : ""} · a ${LINK_BPS / 1000} kbps radio would need ${Math.ceil(p.total * 8 * 4 / 3 / LINK_BPS / 60)} min`;
        } });
        text.textContent = `${name}: ${kb(r.bytes)} up in ${r.seconds.toFixed(0)} s (${kb(r.gz)} compressed), CRC-32 verified on board, stored on the SD card.`;
      }
    } catch (e) { text.textContent = "Upload failed: " + e.message; }
    uploading = false; render();
  };

  // ---- playing ----
  const gctx = $("gs-ground").getContext("2d"), img = gctx.createImageData(320, 200);
  let pending = [], loop = null;
  const down = new Set();
  const key = (e, isDown) => {
    if (!gs.doom || panel.hidden) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName) && e.target.id !== "gs-ground") return;
    const k = DOOM_KEYS[e.code]; if (k === undefined) return;
    e.preventDefault();
    if (isDown === down.has(e.code)) return;   // ignore auto-repeat
    if (isDown) down.add(e.code); else down.delete(e.code);
    pending.push([isDown ? 1 : 0, k]);
  };
  window.addEventListener("keydown", (e) => key(e, true));
  window.addEventListener("keyup", (e) => key(e, false));
  window.addEventListener("blur", () => { for (const c of down) pending.push([0, DOOM_KEYS[c]]); down.clear(); });

  $("gs-start").onclick = async () => {
    if (!wasm) wasm = { sat: null, ground: new Uint8Array(await (await fetch(`payload/doom-ground.wasm?v=${window.BUILD}`)).arrayBuffer()) };
    await gs.startDoom(wasm.ground, wad);
    pending = []; down.clear();
    $("gs-ground").focus();
    clearInterval(loop);
    loop = setInterval(step, 1000 / TICRATE);
    setTimeout(() => fc.requestMap(), 8000);   // colour the payload's memory on the board
    render();
  };
  $("gs-stop").onclick = () => { clearInterval(loop); loop = null; gs.stopDoom(); renderSync(); render(); };

  function step() {
    const d = gs.doom; if (!d) return;
    if (d.satReady === null && !d.ended) { draw(d); return renderSync(); }
    // keep within a second of the satellite, so the two stay comparable while you play
    if (!d.ended && d.ground.tic - (d.satTic + 1) >= MAX_AHEAD) return renderSync();
    gs.doomTick(pending); pending = [];
    draw(d); renderSync();
  }
  function draw(d) { d.ground.frame(img.data); gctx.putImageData(img, 0, 0); }
  function renderSync() {
    const d = gs.doom, el = $("gs-sync"), fig = $("gs-satfig");
    fig.classList.toggle("diverged", !!(d && d.diverged));
    if (!d) { el.textContent = ""; el.className = "gs-sync"; return; }
    const behind = d.ground.tic - 1 - d.satTic;
    let t, cls = "dim";
    if (d.satReady === null && !d.ended) t = "waiting for the satellite to start Doom…";
    else if (d.diverged) { t = `✗ frames differ since tic ${d.diverged.tic}: the satellite's copy has been changed · tic ${d.ground.tic}`; cls = "bad"; }
    else { t = `✓ ${Math.max(0, d.satTic + 1)} frames match · tic ${d.ground.tic}${behind > 2 ? ` · satellite ${behind} tics behind` : ""}`; cls = "ok"; }
    if (d.ended) { t += ` · satellite: ${d.ended}`; cls = "bad"; }
    el.textContent = t; el.className = "gs-sync " + cls;
  }
  bus.on("doom", () => { renderSync(); render(); });
  render();
  return gs;
}
