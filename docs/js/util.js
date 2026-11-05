// Small helpers shared by every module.
export const $ = (id) => document.getElementById(id);
export const BUILD = window.BUILD;   // set in index.html; bump it whenever the VM images change
export const hex2 = (v) => v.toString(16).padStart(2, "0");
export const hexAddr = (pa) => "0x" + pa.toString(16).padStart(7, "0");
export const popcount = (m) => { let n = 0; for (let x = m; x; x >>= 1) n += x & 1; return n; };

// A tiny event bus: hardware and the OS adapter emit, the UI listens.
const listeners = new Map();
export const bus = {
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
  emit(type, data = {}) { for (const fn of listeners.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } for (const fn of listeners.get("*") || []) { try { fn({ type, ...data }); } catch (e) { console.error(e); } } },
};

// newc cpio: 110-byte ASCII header, name, data; name and data padded to 4 bytes
export function parseCpio(u8) {
  const out = []; let off = 0; const td = new TextDecoder();
  const hexAt = (o) => parseInt(td.decode(u8.subarray(o, o + 8)), 16);
  while (off + 110 <= u8.length && td.decode(u8.subarray(off, off + 6)) === "070701") {
    const mode = hexAt(off + 14), size = hexAt(off + 54), nameSize = hexAt(off + 94);
    const name = td.decode(u8.subarray(off + 110, off + 110 + nameSize - 1));
    const dataOff = (off + 110 + nameSize + 3) & ~3;
    if (name === "TRAILER!!!") break;
    if ((mode & 0o170000) === 0o100000 && size > 0) out.push({ name, dataOff, size });
    off = (dataOff + size + 3) & ~3;
  }
  return out.sort((a, b) => a.dataOff - b.dataOff);
}

// Firmware plus the launch image of the boot storage: what is written on the
// SD card before launch, and what the ground can re-upload.
export async function loadImages(os) {
  const get = async (u) => { const r = await fetch(`${u}?v=${BUILD}`); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r; };
  const [bios, vga, kernel, rootfs] = await Promise.all(["bios.bin", "vgabios.bin", os.images.kernel, os.images.rootfs].map(get));
  const fs = os.images.rootfs.endsWith(".gz")
    ? new Uint8Array(await new Response(rootfs.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
    : new Uint8Array(await rootfs.arrayBuffer());
  return { bios: await bios.arrayBuffer(), vga: await vga.arrayBuffer(), kernel: new Uint8Array(await kernel.arrayBuffer()), fs, files: parseCpio(fs) };
}
