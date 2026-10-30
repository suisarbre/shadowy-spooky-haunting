# SpaceY flight software in the browser

NASA's core Flight System (cFS) running unmodified inside a 32-bit Linux VM, emulated in the browser by [v86](https://github.com/copy/v86). Everything is static files, so it can be served from GitHub Pages.

## Run it

Serve `docs/` with any static server, or enable GitHub Pages on this repo (Settings → Pages → branch `main`, folder `/docs`).

```
cd docs && python3 -m http.server 8000
# open http://localhost:8000
```

The VM boots in about 10 s. Click **Start cFS**, then **Enable telemetry**. The buttons send real CCSDS commands to cFS. The second row of buttons drives FAULT_INJ: hit SAMPLE_APP's counter and watch it jump in telemetry, or corrupt its code and watch the flight software crash.

No special server headers are needed: v86 runs single-threaded, so GitHub Pages works as is.

## FAULT_INJ: radiation upset simulator

`build/cfs/apps/fault_inj` is a cFS app that flips bits in other apps' memory on command, like a single-event upset. It finds each target's code, read-only data, data and BSS regions from the loaded module's ELF segments, so hits can be aimed precisely and repeated exactly.

| Code | Command | Payload (little-endian) |
|---|---|---|
| 0 | NOOP | none |
| 1 | RESET counters | none |
| 2 | QUERY memory map | `App[20]` |
| 3 | FLIP one byte | `App[20]`, `Region u8`, `BitMask u8`, `spare u16`, `Offset u32` |
| 4 | FLIP_RANDOM | `App[20]`, `Region u8`, `spare u8`, `Count u16`, `Seed u32` (0 = time-based) |
| 5 | FLIP_SYMBOL | `App[20]`, `Symbol[32]`, `Offset u32`, `BitMask u8`, `spare[3]` |

Commands go to MID `0x18C0`; housekeeping comes back on `0x08C0` once a second. Regions: 0 code, 1 rodata, 2 data, 3 bss. App `CORE` targets the cFS executive itself. Offsets wrap to the region size, so the same (app, region, offset) always hits the same byte.

Tested in v86 (`test/test-fault.mjs`, 11/11 pass):

- Flipping bit 7 of `SAMPLE_APP_Data` makes SAMPLE_APP's telemetry command counter jump from 0 to 128.
- The same FLIP twice hits the same address and restores the original value.
- 8 random hits in SAMPLE_APP's data: flight software keeps running.
- 40 random hits in SAMPLE_APP's code, then commanding it: **the whole flight software process crashes**, Health & Safety included, and a restart comes back as a processor reset in ~3 s.

That last result is the point of the demo: on Linux, cFS runs every app as a thread in one process with no memory isolation between apps, so one corrupted app can take down everything. Real missions answer this with partitioned operating systems and an external hardware watchdog.

To add it to a cFS tree: copy `apps/fault_inj` into `apps/`, and use the three files in `build/cfs/sample_defs/` (adds `fault_inj` to the cpu1 app list and startup script, and subscribes TO_LAB to `0x08C0`).

## How it fits together

```
browser JS  --ttyS1 (hex lines)-->  serbridge  --UDP 1234-->  CI_LAB  --> cFS software bus
browser JS  <--ttyS1 (hex lines)--  serbridge  <--UDP 2234--  TO_LAB  <-- cFS software bus
browser JS  <--ttyS0-->  busybox shell (console, start/stop cFS)
```

- `C<hex>\n` from the page = one command packet; `T<hex>\n` from the VM = one telemetry packet.
- Command message IDs: ES `0x1806`, TO_LAB `0x1880`. Telemetry: ES HK `0x0800`, events `0x0808`.

## What's in `docs/`

| File | Size | What |
|---|---|---|
| `bzImage` | 1.5 MB | Linux 6.8 kernel, i386, minimal config |
| `initrd.gz` | 5.4 MB | busybox + 32-bit glibc + cFS (cFE, OSAL, PSP, 13 apps) + serbridge |
| `libv86.js`, `v86.wasm` | 2.4 MB | v86 0.5.470 |
| `bios.bin`, `vgabios.bin` | 0.2 MB | SeaBIOS |

## Verified (headless, `test/test-cfs.mjs`, 12/12 pass)

| Check | Result |
|---|---|
| Linux boots in v86 | ~10 s |
| cFS reaches OPERATIONAL | ~4 s after launch |
| Apps loaded with dlopen | 13 apps + 2 libs |
| Threads / message queues | 26 threads, 23 POSIX queues, ~6 MB RSS |
| Telemetry cFS → UDP → serial → JS | yes |
| Commands JS → serial → UDP → cFS (ES No-op) | yes |
| Scheduler keeps real-time cadence | ES HK every 4.0 s as configured |
| ES Restart App | works |
| ES Reload App from a new `.so` (update path) | works |
| `kill -9` + restart (watchdog path) | back to OPERATIONAL in ~3 s, cFS reports a processor reset |

## Gotchas found while porting

- **Kernel needs `CONFIG_RT_MUTEXES` (PI futexes) and `CONFIG_COMPAT_32BIT_TIME`.** OSAL creates priority-inheritance mutexes; 32-bit glibc probes PI support through the legacy `futex` syscall. Without both, `pthread_mutex_init` fails with "Operation not supported" and OSAL refuses to start.
- **TO_LAB sends telemetry to UDP 2234**, not 1235.
- **ES Reload only accepts cFS virtual paths** like `/cf/app.so`. A path like `/tmp/app.so` fails with `CFE_ES_FILE_IO_ERR`.
- OSAL unlinks queue names, so `/dev/mqueue` looks empty even when queues are live.

## Rebuilding

`build/` has the pieces: the kernel config (`kernel/config-i386-v86`), the cFS toolchain file (`cfs/toolchain-i686-v86.cmake`, `-m32`), the VM `init`, `serbridge.c`, and `build-initrd.sh`. Built on Ubuntu 24.04 with `gcc-multilib`.

cFS build: copy the toolchain file into `sample_defs/`, then

```
cmake -S cfe -B build-v86 -DSIMULATION=i686-v86 -DMISSIONCONFIG=sample -DCFE_EDS_ENABLED=OFF \
      -DCMAKE_BUILD_TYPE=release -DCMAKE_INSTALL_PREFIX=/exe -DENABLE_UNIT_TESTS=FALSE
make -C build-v86 mission-install
```
