// The ground station's copy of Doom: the same doomgeneric source as the satellite payload, built
// for WebAssembly (build/doom/build-doom.sh). It needs only a few WASI calls: reading the game data
// file, writing its log, and a throwaway sink for the config file it saves on exit. It never reads
// a clock, so it runs exactly one tic per tick() and stays in lockstep with the satellite.

const ENOENT = 44, EBADF = 8, ENOSYS = 52;

export class GroundDoom {
  // wasmBytes: doom-ground.wasm; wad: { name, bytes: Uint8Array }
  static async create(wasmBytes, wad, { log = () => {} } = {}) {
    const g = new GroundDoom(); g.wad = wad; g.log = log;
    const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: g.wasi() });
    g.x = instance.exports; g.x._initialize();
    const name = "/" + wad.name, buf = g.x.dg_iwad_buf();
    new Uint8Array(g.x.memory.buffer, buf, name.length + 1).set([...new TextEncoder().encode(name), 0]);
    g.hash = g.x.dg_create() >>> 0;
    g.tic = 0;
    return g;
  }
  // one tic with these key events ([down 0/1, doomKey]); returns the frame hash
  tick(events = []) {
    for (const [d, k] of events) this.x.dg_keyev(d, k);
    this.hash = this.x.dg_tick() >>> 0; this.tic++;
    return this.hash;
  }
  // the frame as RGBA bytes for a 320x200 ImageData (Doom writes BGRA with alpha 0)
  frame(out) {
    const src = new Uint8Array(this.x.memory.buffer, this.x.dg_screen(), 320 * 200 * 4);
    for (let i = 0; i < src.length; i += 4) { out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = 255; }
    return out;
  }

  wasi() {
    const fds = new Map([[3, { dir: true }]]);   // 3: the preopened root
    let next = 4, outText = "";
    const mem = () => new DataView(this.x.memory.buffer), u8 = () => new Uint8Array(this.x.memory.buffer);
    const str = (p, n) => new TextDecoder().decode(u8().subarray(p, p + n));
    const iovs = (p, n) => { const v = mem(), out = []; for (let i = 0; i < n; i++) out.push([v.getUint32(p + i * 8, true), v.getUint32(p + i * 8 + 4, true)]); return out; };
    return {
      fd_prestat_get: (fd, p) => { if (fd !== 3) return EBADF; const v = mem(); v.setUint8(p, 0); v.setUint32(p + 4, 1, true); return 0; },
      fd_prestat_dir_name: (fd, p, n) => { if (fd !== 3) return EBADF; u8()[p] = 47; return 0; },
      fd_fdstat_get: (fd, p) => {
        const v = mem(), f = fds.get(fd);
        v.setUint8(p, fd < 3 ? 2 : f && f.dir ? 3 : 4); v.setUint16(p + 2, 0, true);
        v.setBigUint64(p + 8, 0xffffffffffffffffn, true); v.setBigUint64(p + 16, 0xffffffffffffffffn, true);
        return fd < 3 || f ? 0 : EBADF;
      },
      fd_fdstat_set_flags: () => 0,
      path_open: (dirfd, dirflags, pp, pl, oflags, rb, ri, fdflags, outp) => {
        const path = str(pp, pl).replace(/^\.?\//, "");
        const writing = (oflags & 1) || (rb & 0x40n);   // O_CREAT, or the fd_write right
        let f;
        if (path === this.wad.name && !writing) f = { data: this.wad.bytes, pos: 0 };
        else if (writing) f = { sink: true };            // config and save files: accepted, thrown away
        else return ENOENT;
        const fd = next++; fds.set(fd, f); mem().setUint32(outp, fd, true); return 0;
      },
      fd_read: (fd, ip, il, outp) => {
        const f = fds.get(fd); if (!f || !f.data) { mem().setUint32(outp, 0, true); return f ? 0 : EBADF; }
        let n = 0;
        for (const [b, len] of iovs(ip, il)) { const k = Math.min(len, f.data.length - f.pos); u8().set(f.data.subarray(f.pos, f.pos + k), b); f.pos += k; n += k; if (k < len) break; }
        mem().setUint32(outp, n, true); return 0;
      },
      fd_seek: (fd, off, whence, outp) => {
        const f = fds.get(fd); if (!f) return EBADF;
        const size = f.data ? f.data.length : 0, o = Number(off);
        f.pos = whence === 0 ? o : whence === 1 ? (f.pos || 0) + o : size + o;
        mem().setBigUint64(outp, BigInt(f.pos), true); return 0;
      },
      fd_write: (fd, ip, il, outp) => {
        let n = 0;
        for (const [b, len] of iovs(ip, il)) { if (fd === 1 || fd === 2) outText += str(b, len); n += len; }
        if (outText.includes("\n")) { const lines = outText.split("\n"); outText = lines.pop(); for (const l of lines) this.log(l); }
        mem().setUint32(outp, n, true); return 0;
      },
      fd_close: (fd) => { fds.delete(fd); return 0; },
      path_create_directory: () => 0,
      path_remove_directory: () => ENOSYS,
      path_rename: () => ENOSYS,
      path_unlink_file: () => ENOSYS,
      proc_exit: (code) => { throw new Error("doom exited (" + code + ")"); },
    };
  }
}

// browser KeyboardEvent.code -> Doom key code (doomkeys.h), default controls
export const DOOM_KEYS = {
  ArrowUp: 0xad, ArrowDown: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
  KeyW: 0xad, KeyS: 0xaf, KeyA: 0xa0, KeyD: 0xa1,           // also strafe on A/D
  ControlLeft: 0x9d, ControlRight: 0x9d, Space: 0x20,         // fire (right ctrl), use
  ShiftLeft: 0xb6, ShiftRight: 0xb6, AltLeft: 0xb8, AltRight: 0xb8,  // run, strafe
  Enter: 13, Escape: 27, Tab: 9, Backspace: 0x7f, KeyY: 0x79, KeyN: 0x6e,
  Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34, Digit5: 0x35, Digit6: 0x36, Digit7: 0x37,
  Minus: 0x2d, Equal: 0x3d,
};
