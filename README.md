# SpaceY flight software in the browser

NASA's core Flight System (cFS) running unmodified inside a 32-bit Linux VM, emulated in the browser by [v86](https://github.com/copy/v86). Everything is static files, so it can be served from GitHub Pages.

## Run it

Serve `docs/` with any static server, or enable GitHub Pages on this repo (Settings → Pages → branch `main`, folder `/docs`).

```
cd docs && python3 -m http.server 8000
# open http://localhost:8000
```

The VM boots in about 10 s. The flight computer boots straight into cFS (about 14 s) and turns on telemetry by itself. The buttons send real CCSDS commands to cFS. Like a ground station, the page watches telemetry: if nothing arrives for 6 s it checks whether the flight software process is still alive and reports either a crash or a hang. The second row of buttons drives FAULT_INJ: hit SAMPLE_APP's counter and watch it jump in telemetry, or corrupt its code and watch the flight software crash.

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
| 6 | SET_ECC | `Enabled u8` (1 on, 0 off), `spare[3]` |
| 7 | FLIP_TMR | `Region[20]`, `Copy u8` (0–2), `BitMask u8`, `spare u16`, `Offset u32`: hits one copy of a TMR_LIB region |

Commands go to MID `0x18C0`; housekeeping comes back on `0x08C0` once a second. Regions: 0 code, 1 rodata, 2 data, 3 bss. App `CORE` targets the cFS executive itself. Offsets wrap to the region size, so the same (app, region, offset) always hits the same byte.

**Simulated ECC.** The emulated PC has plain RAM, so error-correcting memory is modeled inside FAULT_INJ, standing in for the memory controller. With ECC on, a single-bit hit is corrected before software sees it (memory unchanged, counted, reported as an event); a multi-bit hit in one byte is detected but uncorrectable, so the data is corrupted and a critical event is raised. Corrections are treated as immediate, as if reads or scrubbing catch each flip before a second one lands in the same word. Housekeeping adds `EccEnabled` (byte 52), `EccCorrected` (u32 at 56) and `EccUncorrectable` (u32 at 60).

Tested in v86 (`test/test-fault.mjs`, 15/15 pass):

- Flipping bit 7 of `SAMPLE_APP_Data` makes SAMPLE_APP's telemetry command counter jump from 0 to 128.
- The same FLIP twice hits the same address and restores the original value.
- 8 random hits in SAMPLE_APP's data: flight software keeps running.
- 40 random hits in SAMPLE_APP's code, then commanding it: **the whole flight software process crashes**, Health & Safety included, and a restart comes back as a processor reset in ~3 s.

- With ECC on: a 1-bit hit on the counter is corrected (stays 0), a 2-bit hit gets through (0 → 129) and is flagged uncorrectable, and the same 40 code hits that crashed everything are all corrected, so the flight software survives.

The crash result is the point of the demo: on Linux, cFS runs every app as a thread in one process with no memory isolation between apps, so one corrupted app can take down everything. Real missions answer this with partitioned operating systems and an external hardware watchdog.

To add it to a cFS tree: copy `apps/fault_inj` into `apps/`, and use the three files in `build/cfs/sample_defs/` (adds `fault_inj` to the cpu1 app list and startup script, and subscribes TO_LAB to `0x08C0`).

## Hardware watchdog

On a real spacecraft the watchdog is a separate chip: the flight software must keep "kicking" it, and if the kicks stop the chip resets the computer. cFS already has this design. Health & Safety arms the watchdog at startup (10 s timeout) and services it every cycle (about once a second) while the system is healthy. On the stock Linux PSP those calls are empty, so `build/cfs/psp/cfe_psp_watchdog.c` sends them to an onboard serial bus instead:

| Line on `/dev/ttyS2` | Meaning |
|---|---|
| `WS<ms>` | set timeout |
| `WE` / `WD` | enable / disable |
| `WK` | kick |

The page models the chip. If no kick arrives within the timeout it power-cycles the flight computer (the v86 instance is destroyed and a new one boots; v86's own `restart()` does not handle a bzImage boot). The VM's `init` boots straight into cFS when the kernel command line has `fsw=auto`, so the flight software comes back with no one at the keyboard, and cFS logs a power-on reset. The **Watchdog: ON/OFF** button disconnects the chip for the before/after comparison.

Tested in v86 (`test/test-watchdog.mjs`, 9/9 pass):

| Scenario | Result |
|---|---|
| Healthy | Health & Safety arms the chip (`WS10000`, `WE`) and kicks about once a second |
| 40 code hits crash the flight software | Watchdog resets ~11 s later; cFS back ~12 s after that, logging a power-on reset |
| Flight software hangs (`kill -STOP`) | Same: reset after ~10 s, back on its own |
| Watchdog disconnected, flight software killed | Stays down |

## Boot storage and latent damage

The page keeps the flight computer's boot storage, the kernel and the root filesystem, in browser memory, the way a spacecraft keeps its software in flash. Every power-on boots from storage as it is at that moment. The filesystem is kept uncompressed (decompressed once at load) so a hit damages one file instead of breaking the whole archive.

**Hit storage** flips one bit at a chosen file, offset and bit. The running system does not notice, because it already sits in RAM; the damage waits for the next boot. **Power cycle** reboots on ground command, **Restore storage** re-uploads the launch image, and the counter shows how many bits differ from it.

The watchdog now runs from power-on with a 30 s boot window (Health & Safety tightens it to 10 s once up), so a computer that cannot boot gets reset again and again: a boot loop, which the page flags after two failed boots in a row.

Tested in Chrome (`test/browser-storage.mjs`):

| Storage hit (offset 0, bit 0) | Next boot |
|---|---|
| `lib/libc.so.6` (unused duplicate; the 32-bit loader uses `lib32/`) | Normal |
| `cfs/cpu1/cf/sample_app.so` | cFS logs `Could not load file:/cf/sample_app.so`, everything else runs |
| `cfs/cpu1/core-cpu1` | ELF signature broken, the shell tries to run it as a script and fails: boot loop |
| `kernel` + 20000, bit 3 | Boot loop |
| Restore storage during the loop | Next watchdog reset boots clean |

This sets up the next step, a protected golden image the boot loader can fall back to.

## Two configurations: single computer, or TMR

The **Configuration** menu switches between:

- **1 computer: ECC + watchdog + reboot.** Everything above. A fault is survived by correcting it (ECC) or by rebooting (watchdog), with an outage of about 25 s.
- **3 computers: TMR with voter.** Triple modular redundancy. Three identical flight computers run side by side, each with its own boot storage and watchdog. A voter outside them, like voting hardware, does three things:
  - fans every ground command out to all three;
  - each second compares what they report: is each one up, and do they agree on SAMPLE_APP's command counter (an application output)? The ground sees only the majority value, so one bad computer is masked with no outage;
  - resyncs a computer that is down, or has disagreed with the other two for 12 s, by copying the full running state of a healthy one into it (v86 `save_state` / `restore_state`), the way TMR systems bring a failed unit back in step.

Radiation controls (counter hits, code hits, storage hits, kill) act on the **target** computer only.

Comparing raw telemetry would not work: the three computers are not clock-locked, so timestamps and sequence counts differ even when they agree. The voter compares a chosen application value instead and tolerates the few seconds between housekeeping reports.

Measured in headless Chrome on a 2-core machine (`test/browser-modes.mjs`, 11/11 pass):

| | Result |
|---|---|
| Boot, 1 computer / 3 computers | ~11 s / ~29 s |
| Watchdog kicks with 3 computers running | ~0.85/s each, longest gap 1.3 s (limit 10 s) |
| Snapshot size, save + restore | 39 MB, ~0.6 s |
| 1-bit hit on B's counter | B shows 128, ground keeps 0; B outvoted and resynced from A in 0.67 s |
| C's flight software killed | Resynced from A ~5 s later, no reboot, watchdog never fires |
| Ground command after resyncs | Reaches all three |
| Single mode, code hits | Watchdog reset, back on its own |

Memory stays at 128 MB per computer: at 64 MB the 12.5 MB filesystem no longer fits the kernel's boot layout.

## Software TMR inside one computer

The hardware profile asks for TMR in the kernel: every critical state transition or calculation done in three independent memory partitions and voted, with a corrupted partition overwritten from the other two without a reboot. That is implemented as a cFS service layer, not in the Linux kernel:

- **`libs/tmr_lib`** (a cFS library, loaded before the apps). `TMR_Alloc` creates a region as three separate memory mappings, each followed by a guard page, so one upset cannot reach two copies. `TMR_Vote` takes the bitwise majority of the three copies, `(a & b) | (a & c) | (b & c)`, and overwrites any copy that differs. `TMR_SetEnabled(false)` drops to one copy with no voting, for comparison.
- **`apps/tmr_calc`** (TMR_CALC). A calculator the ground can check: every second `Step += 1; Sum += Step`, so `Sum` must equal `Step × (Step + 1) / 2`. Each of the three copies does its own calculation from its own state, then the copies are voted. Because the sum accumulates, an error that gets through stays visible. Commands on `0x18C1` (0 NOOP, 1 RESET, 2 SET_TMR); results on `0x08C1` once a second, including each copy's value before the vote.
- **FAULT_INJ `FLIP_TMR`** hits one chosen copy.

The page's calculator panel shows step, the correct sum, the reported (voted) sum with ✓/✗, the three copies and which one was just outvoted, and buttons to hit each copy, both copies 1 and 2, toggle TMR, and reset.

Tested in v86 (`test/test-tmr.mjs`, 12/12) and in Chrome (`test/browser-calc.mjs`, 10/10):

| Scenario | Result |
|---|---|
| Hit copy 2 (sum field) | Copy 2 computes 20 instead of 36, is outvoted and repaired; answer stays right; no reboot |
| Hit copy 3 (step field) | Repaired the same way |
| Same bit in copies 1 and 2 | The wrong value wins the vote and the good copy is "repaired" to it; the sum stays wrong from then on |
| TMR off, hit copy 2 | No effect (copy unused) |
| TMR off, hit copy 1 | Answer wrong for good |
| TMR back on | Copies agree again but past damage stays: TMR cannot undo an error it never saw |

Limits worth stating: the data is triplicated but the code and the CPU are not, so a hit in the calculation code itself is not covered (ECC, the watchdog, or three computers cover that); and with ECC on, single-bit hits are corrected before TMR ever sees them.

## How it fits together

```
browser JS  --ttyS1 (hex lines)-->  serbridge  --UDP 1234-->  CI_LAB  --> cFS software bus
browser JS  <--ttyS1 (hex lines)--  serbridge  <--UDP 2234--  TO_LAB  <-- cFS software bus
browser JS  <--ttyS0-->  busybox shell (console, start/stop cFS)
browser JS  <--ttyS2---  cFS Health & Safety -> PSP watchdog calls (hardware watchdog chip)
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
