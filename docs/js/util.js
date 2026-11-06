// Small helpers shared by every module.
export const $ = (id) => document.getElementById(id);
export const BUILD = window.BUILD;   // set in index.html; bump it whenever the VM images change
export const hex2 = (v) => v.toString(16).padStart(2, "0");
export const hexAddr = (pa) => "0x" + pa.toString(16).padStart(7, "0");
export const popcount = (m) => { let n = 0; for (let x = m; x; x >>>= 1) n += x & 1; return n; };

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
    if ((mode & 0o170000) === 0o100000 && size > 0 && name !== "TRAILER!!!") out.push({ name, dataOff, size });
    off = (dataOff + size + 3) & ~3;
    // archives can follow one another (files the ground uplinked are appended as one more): skip the padding
    if (name === "TRAILER!!!") while (off < u8.length && u8[off] === 0) off++;
  }
  return out.sort((a, b) => a.dataOff - b.dataOff);
}

// A cpio "newc" archive: [{ name, dir: true } | { name, data: Uint8Array }], with its trailer.
export function cpioArchive(entries) {
  const parts = [], te = new TextEncoder(), hx = (n) => (n >>> 0).toString(16).padStart(8, "0");
  let ino = 0x7000, len = 0;
  const pad = () => { const p = (4 - (len % 4)) % 4; if (p) { parts.push(new Uint8Array(p)); len += p; } };
  const add = (name, mode, data) => {
    const nm = te.encode(name + "\0"), size = data ? data.length : 0;
    const h = te.encode("070701" + [ino++, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, nm.length, 0].map(hx).join(""));
    parts.push(h, nm); len += h.length + nm.length; pad();
    if (data) { parts.push(data); len += data.length; pad(); }
  };
  for (const e of entries) add(e.name, e.dir ? 0o40755 : 0o100644, e.dir ? null : e.data);
  add("TRAILER!!!", 0, null);
  const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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
