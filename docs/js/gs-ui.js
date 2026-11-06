// The ground station panel: the SD card's data partition, uplinks, running programs on the
// satellite, and the lockstep check for programs the ground can run too.
import { $, bus } from "./util.js";
import { GroundStation, LINK_BPS, gunzip, doomTwin, validName } from "./ground.js";
import { DOOM_KEYS } from "./doom-ground.js";

const TICRATE = 35, MAX_AHEAD = 35;   // the ground may run up to 1 s of tics ahead of the satellite
const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const asset = async (path) => { const r = await fetch(`${path}?v=${window.BUILD}`); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };

export function createGroundUI({ fc }) {
  const gs = new GroundStation({ fc });
  let doomWasm = null;
  gs.twins.set("doom", async (args, files) => { doomWasm = doomWasm || await asset("payload/doom-ground.wasm"); return doomTwin(doomWasm)(args, files); });
  const panel = $("gs"), openBtn = $("gs-open");
  let uploading = false;

  const setOpen = (on) => { panel.hidden = !on; openBtn.setAttribute("aria-expanded", String(on)); if (on) renderFiles(); };
  openBtn.onclick = () => setOpen(panel.hidden);
  $("gs-close").onclick = () => setOpen(false);

  // ---- files ----
  function renderFiles() {
    const ul = $("gs-files"), files = gs.files();
    ul.innerHTML = "";
    if (!files.length) { const li = document.createElement("li"); li.className = "dim"; li.textContent = "empty"; ul.append(li); }
    for (const f of files) {
      const li = document.createElement("li"), name = document.createElement("span"), del = document.createElement("button");
      name.innerHTML = `<b></b> ${kb(f.size)}`; name.firstChild.textContent = f.name;
      del.textContent = "delete"; del.setAttribute("aria-label", `Delete ${f.name} from the satellite`); del.disabled = uploading;
      del.onclick = async () => { try { await gs.remove(f.name); } catch (e) { $("gs-up-text").textContent = e.message; } };
      li.append(name, del); ul.append(li);
    }
    const li = document.createElement("li"); li.className = "dim"; li.textContent = `${kb(fc.sdFree())} free`; ul.append(li);
    for (const id of ["gs-pre-doom", "gs-pre-sys"]) $(id).disabled = uploading || !fc.emu;
    $("gs-pick").disabled = uploading;
  }
  bus.on("sd-write", renderFiles); bus.on("state", renderFiles);

  async function send(list) {   // [{ name, bytes, gz? }]
    uploading = true; renderFiles();
    const bar = $("gs-bar"), text = $("gs-up-text");
    try {
      for (const f of list) {
        const r = await gs.uplink(f.name, f.bytes, { gz: f.gz, onProgress: (p) => {
          bar.style.width = (100 * p.sent / p.total).toFixed(1) + "%";
          text.textContent = `${f.name}: ${kb(p.sent)} / ${kb(p.total)} compressed · ${kb(p.rate)}/s${p.resent ? ` · ${p.resent} chunks resent` : ""} · a ${LINK_BPS / 1000} kbps radio would need ${Math.ceil(p.total * 8 * 4 / 3 / LINK_BPS / 60)} min`;
        } });
        text.textContent = `${f.name}: ${kb(r.bytes)} up in ${r.seconds.toFixed(0)} s (${kb(r.gz)} compressed), CRC-32 verified on board, now at /sd/${f.name}.`;
      }
      return true;
    } catch (e) { text.textContent = "Upload failed: " + e.message; return false; }
    finally { uploading = false; renderFiles(); }
  }
  $("gs-pick").onchange = async (e) => {
    const picked = [...e.target.files]; e.target.value = "";
    const bad = picked.filter((f) => !validName(f.name));
    if (bad.length) { $("gs-up-text").textContent = `Rename first (letters, digits and . _ + - only): ${bad.map((f) => f.name).join(", ")}`; return; }
    await send(await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  };
  // ready-made payloads: the files come with the page; only what is missing on the satellite goes up
  $("gs-pre-doom").onclick = async () => {
    $("gs-up-text").textContent = "Fetching Doom and Freedoom…";
    try {
      const list = [];
      if (!gs.has("doom") || !gs.local.has("doom")) list.push({ name: "doom", bytes: await asset("payload/doom-i386") });
      if (!gs.has("freedoom1.wad") || !gs.local.has("freedoom1.wad")) { const gz = await asset("payload/freedoom1.wad.gz"); list.push({ name: "freedoom1.wad", bytes: await gunzip(gz), gz }); }
      if (await send(list)) $("gs-cmd").value = "doom -iwad freedoom1.wad -mb 16";
    } catch (e) { $("gs-up-text").textContent = e.message; }
  };
  $("gs-pre-sys").onclick = async () => {
    if (await send([{ name: "sysreport.sh", bytes: await asset("payload/sysreport.sh") }])) $("gs-cmd").value = "./sysreport.sh";
  };

  // ---- running ----
  const out = $("gs-out");
  $("gs-run-form").onsubmit = (e) => { e.preventDefault(); const c = $("gs-cmd").value.trim(); if (!c) return; out.textContent = ""; gs.start(c); $("gs-sat").focus(); };
  $("gs-stop").onclick = () => gs.stop();
  $("gs-in-form").onsubmit = (e) => { e.preventDefault(); const v = $("gs-in").value; if (v === "") return; gs.stdin(v); $("gs-in").value = ""; };
  bus.on("run-output", ({ line }) => {
    const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    out.textContent += line + "\n";
    if (out.textContent.length > 60000) out.textContent = out.textContent.slice(-40000);
    if (atEnd) out.scrollTop = out.scrollHeight;
  });

  // ---- lockstep: keys per tic, the ground's copy on screen, the check ----
  const gctx = $("gs-ground").getContext("2d"), img = gctx.createImageData(320, 200);
  let pending = [];
  const down = new Set();
  const key = (e, isDown) => {
    const r = gs.run; if (!r || !r.lock || panel.hidden) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
    const k = DOOM_KEYS[e.code]; if (k === undefined) return;
    e.preventDefault();
    if (isDown === down.has(e.code)) return;   // ignore auto-repeat
    if (isDown) down.add(e.code); else down.delete(e.code);
    pending.push([isDown ? 1 : 0, k]);
  };
  window.addEventListener("keydown", (e) => key(e, true));
  window.addEventListener("keyup", (e) => key(e, false));
  window.addEventListener("blur", () => { for (const c of down) pending.push([0, DOOM_KEYS[c]]); down.clear(); });
  setInterval(() => {
    const r = gs.run, L = r && r.lock; if (!L || !L.ready || r.exited) return;
    if (L.tic - (L.satTic + 1) >= MAX_AHEAD) return;   // keep within a second of the satellite
    gs.lockstepTick(pending); pending = [];
    if (L.twin) { L.twin.frame(img.data); gctx.putImageData(img, 0, 0); }
    renderRun();
  }, 1000 / TICRATE);

  function renderRun() {
    const r = gs.run, L = r && r.lock, el = $("gs-sync");
    const running = !!(r && !r.exited);
    $("gs-stop").disabled = !running; $("gs-in").disabled = !running || !!L; $("gs-send").disabled = !running || !!L;
    $("gs-satfig").classList.toggle("diverged", !!(L && L.diverged));
    $("gs-gnote").hidden = !!(L && L.twin);
    if (L && !L.twin && L.twinNote) $("gs-gnote").textContent = L.twinNote;
    let t = "", cls = "dim";
    if (r) {
      if (L) {
        const behind = L.tic - 1 - L.satTic;
        if (!L.twin) t = `lockstep: ${Math.max(0, L.satTic + 1)} tics run on the satellite · ${L.twinNote}`;
        else if (L.diverged) { t = `✗ frames differ since tic ${L.diverged.tic}: what the satellite computed has been changed · tic ${L.tic}`; cls = "bad"; }
        else { t = `✓ ${Math.max(0, L.satTic + 1)} frames match the ground's · tic ${L.tic}${behind > 2 ? ` · satellite ${behind} tics behind` : ""}`; cls = "ok"; }
      } else if (!r.exited) t = `running "${r.cmdline}"`;
      if (r.exited) { t += (t ? " · " : "") + `"${r.cmdline}" ${r.exited}`; cls = L && L.diverged ? "bad" : r.exited.includes("status 0") ? "dim" : "warn"; }
    }
    el.textContent = t; el.className = "gs-sync " + cls;
  }
  bus.on("run", () => { renderRun(); if (gs.run && gs.run.exited) pending = []; });
  bus.on("run", (e) => { if (e.run && e.run.lock) setTimeout(() => fc.requestMap(), 6000); });   // colour the payload's memory on the board
  renderFiles(); renderRun();
  return gs;
}
