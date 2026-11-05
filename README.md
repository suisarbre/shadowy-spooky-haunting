# Radiation vs. a CubeSat flight computer

NASA's core Flight System (cFS) running unmodified on Linux inside an emulated CubeSat on-board computer, in the browser, with [v86](https://github.com/copy/v86). You fire particles at the chips of a 3D board and zoom in until you can see and flip single bits. Six guided missions walk through what each protection does and where it stops working. Everything is static files, served from GitHub Pages.

## Run it

Serve `docs/` with any static server, or use GitHub Pages (branch `main`, folder `/docs`).

```
cd docs && python3 -m http.server 8000
# open http://localhost:8000
```

The flight computer boots into cFS in about 14 s. No special server headers are needed: v86 runs single-threaded.

## What you can do on the page

- **Three protections**, toggled from the top bar: **ECC** (in the memory controller), the hardware **Watchdog**, and **Software TMR** (in the calculator app).
- **Particles that fly in 3D**: a click fires along your line of sight, so the angle is however you hold the board. Choose a single bit (flips exactly the cell you aim at), a light ion, a heavy ion, or a flare burst (48 particles from random directions). How many cells flip comes out of the angle and the particle's energy (below).
- **Background radiation**: particles from random directions at a chosen environment's rate, time-warped, with a survival dashboard (uptime, upsets, ECC outcomes, TMR repairs, crashes, resets).
- **One way to inject faults: hit the hardware.** RAM hits flip bits in the emulated PC's physical memory, and SD card hits damage the boot storage.
- **Semantic zoom** on the memory chips, from the whole board down to single bits (below).
- **Missions**, each with a setup button and goals that tick themselves off:
  1. Break it (no protection)
  2. Let the watchdog recover it
  3. ECC: one bit is free
  4. Where ECC gives up
  5. Software TMR: repair without a reboot
  6. Damage that waits on the SD card
  7. Survive in orbit (background radiation)

## Hardware profile: ISISPACE iOBC

| | iOBC | This emulation |
|---|---|---|
| CPU | 32-bit ARM9, 400 MHz | 32-bit x86 (v86 emulates only x86). cFS is the same code either way thanks to OSAL. CPU hits are not modelled. |
| RAM | 64 MB SDRAM | 64 MB, plus ~9 MB where v86's loader stages the boot image (it always places it at the 64 MB mark; the kernel frees it after unpacking). Optional SECDED ECC in the memory controller. |
| Non-volatile, upset-immune memory | 512 KB FRAM | Holds the boot record: boot count, failed boots in a row, last reset cause. Survives resets; hits have no effect. |
| Storage | SD card | Kernel + root filesystem. Hits are latent until the next boot. The card's own internal ECC is not modelled: a hit stands for damage beyond what it corrects. |
| Watchdog | external | External chip on a serial bus. Runs from power-on with a 30 s boot window; Health & Safety tightens it to 10 s. |
| OS | FreeRTOS | Linux (see "OS adapters" for trying others) |

## The view: a CubeSat in orbit

The page opens on the satellite floating above Earth's limb, turning slowly. Drag to rotate it. Zoom with the wheel, a pinch or the slider at the bottom; the slider shows how far in you are (orbit, computer, memory, bytes, bits).
- **On the way in**: the hull turns to x-ray and the real flight computer board appears inside it.
- **The magnet**: once inside, the view is pulled onto the nearer memory chip (RAM or SD card) and turns to look down on it. Once a chip is under the middle of the screen it leaves the view where you put it (the pivot just settles onto the chip surface); only a view that slips off the chip is eased back over its edge. You can still tilt up to about 50° from vertical at the chip, and 30° at the bits.
- **Limits**: the deepest zoom shows about 24 rows of bits. Deep in, the magnet lets go so you can roam over the memory.
- **Clicking fires a particle** through the point you aim at. It arrives from the upper left of your view, so its track is visible and the angle it meets the chip at depends on how you hold the satellite.
- **Map-style controls inside**: once inside the satellite, drag moves across the board (in the board's plane, so the view stays on the chip). Two fingers, or the right mouse button, zoom and tilt. Outside, drag turns the satellite. The magnet only acts after you let go.
- **The panels** float over the scene: protection and particles, missions, status, event log. On a phone they start folded.

## Semantic zoom: from the board to single bits

Each memory chip's top *is* the memory, laid out like a hex dump. Every 4 KB page is a tile 16 bytes wide and 256 rows tall, and each byte is 8 bits across with the most significant bit on the left. The same point on the chip is always the same byte and bit. Keep zooming (wheel, pinch, or the + button):

| Zoom | What a page looks like |
|---|---|
| Board | one coloured pixel: who owns it (kernel, cFS, an app, a TMR copy, a library, free) |
| Bytes | 16 × 256 texels whose brightness is each byte's value |
| Bits | every bit, lit or dark; bits that just changed flash yellow |
| Text | readable 0s and 1s with byte, ECC-word (8-byte) and page dividers; click one to flip exactly that bit |

The page re-reads the visible part of memory 4 times a second, so you can watch the calculator count. Cells the ECC is hiding show in pink with their real stored value. The bar at the top of the view always says what is under the centre of the screen: physical address, value, owner (process and mapping) and virtual address.

**How hardware is matched to software.** A particle hits physical memory, not a process. `build/memmap.c` runs in the VM on a diagnostic serial port (ttyS3). On request it walks every process's `/proc/<pid>/maps` and `/proc/<pid>/pagemap`, plus `/proc/iomem` for the kernel, and reports runs of physical pages with their owner. TMR_LIB records where its copies are in `/tmp/tmr_regions`. The page refreshes the map when cFS comes up and every 15 s.

Only the visible region is drawn into an overlay texture, so the zoom stays smooth on a phone.

## ECC: a real SECDED code, with a scrubber

`docs/js/ecc.js` implements an extended Hamming (72,64) code, the kind a memory controller keeps next to every 8 bytes: 8 check bits per 64-bit word. The page cannot intercept the emulated CPU's reads, so it keeps, per word, the cells that are flipped and what the word held when they flipped:

| Error in one word | Decoder | On the page |
|---|---|---|
| 1 bit | corrects it on every read | Memory reads right, the cell stays flipped (pink) until the scrubber or a software write replaces the word |
| 2 bits | detects, cannot correct | In memory software uses: machine check, the computer resets. In free memory: the scrubber finds it and retires the page |
| 3+ bits | may "correct" the wrong bit or see nothing | Software silently reads a wrong value |

The scrubber passes every 20 s. A word software rewrites loses its old error, and turning ECC off reveals every error it was hiding.

**A finding for the paper:** of all 41,664 ways to flip 3 bits of a 64-bit word, **76% end up silently wrong** under this code (9,905 detected, 31,759 miscorrected or missed). All 64 single-bit errors are corrected and all 2,016 double-bit errors detected (`ecc.js` is checked exhaustively). That is why real memory interleaves neighbouring cells across words and scrubs often.

## Particle tracks: angle and energy decide how many bits flip

`docs/js/radiation.js` uses a simplified sensitive-volume model, with lengths in memory-cell pitches:
- A sensitive layer 2 cells deep lies under the chip surface. A particle enters where it hits and crosses the layer along its direction.
- Each cell collects charge = LET × the length of track inside it, and 15% of that spreads to the 4 neighbouring cells (charge sharing).
- A cell flips when its charge reaches the critical charge.

| Particle (LET, critical charge = 1) | 0° | 30° | 45° | 60° | 75° | 85° |
|---|---|---|---|---|---|---|
| light ion (0.6) | 1 | 0 | 0 | 0 | 0 | 0 |
| heavy ion (2.5) | 1 | 2 | 3 | 4 | 8 | 24 |
| very heavy ion (6) | 5 | 5 | 5 | 11 | 8 | 24 |

Cells flipped, by angle from vertical. A steep particle flips one cell. A low-angle heavy ion flips a line of cells (about depth × tan(angle)), but leaves less charge in each, so light ions flip nothing at low angles.

**The direction matters as much as the angle.** One row of the chip is 16 bytes, which is two ECC words. A line of upsets **along a row** stays inside one word: ECC detects it but cannot fix it, and in used memory that means a machine check and a reset. The same particle **across rows** puts one bit in each of several words, and ECC corrects them all. This is why real memory interleaves its cells, and mission 4 lets you see it by turning the board.

## Mission board

The top right corner always shows the mission so far, with a Reset button that starts it again:
- **T+**: mission elapsed time. It is time-warped while background radiation is on, and runs at 1× otherwise. Launch (T+0) is the first time the flight software comes up.
- **Uptime and downtime**: share of real time the flight software was up, and how long it was down. These are in real time, because the software runs in real time: a 30 s reboot is 30 s, however fast the radiation clock runs.
- **Outages**: times the flight software went from up to down (crash, hang, reset, boot loop).
- **Resets, bit upsets, ECC fixed**: counted from every source, clicks and background alike.

## Background radiation

Particles arrive at random points on the board from random directions. Through a flat surface the flux goes as cos(angle), and the spectrum is mostly light ions (90% light, 9.5% heavy, 0.5% very heavy).

| Environment | Particles per mission day on the board |
|---|---|
| Quiet low Earth orbit | 0.25 |
| South Atlantic Anomaly pass | 10 |
| Solar particle event | 150 |
| Stress test | 15,000 (far beyond reality) |

These are **illustrative orders of magnitude**, not data for one device. A modern SDRAM in LEO sees roughly one upset in 64 MB every few weeks, and one example (Gaia's SDRAM) ran 1.5–4.3× its usual rate during solar particle events.

Time warp runs from 1 minute to 1 week of mission time per second, capped at 40 particles per real second. Only the radiation is warped: the software runs in real time, so a reboot still takes about 30 s, and uptime is measured in real time.

Only 2% of background particles that reach the SD card leave damage. NAND flash cells hold far more charge than DRAM cells and the card's controller has its own ECC; without this factor a stress run destroys the card within seconds. Clicked SD hits always land.

## Software TMR inside one computer

- **`libs/tmr_lib`**, a cFS library loaded before the apps. `TMR_Alloc` creates a region as three separate memory mappings, each followed by a guard page. `TMR_Vote` takes the bitwise majority `(a & b) | (a & c) | (b & c)` and overwrites any copy that differs. `TMR_SetEnabled(false)` drops to one copy for comparison.
- **`apps/tmr_calc`** (TMR_CALC), a calculator the ground can check. Every second it runs `Step += 1; Sum += Step`, so `Sum` must equal `Step × (Step + 1) / 2`. Each copy computes from its own state, then the copies are voted. Commands go to `0x18C1` (0 NOOP, 1 RESET, 2 SET_TMR) and results come back on `0x08C1`.

The calculator panel's copy buttons fly the camera to each copy's bits.

Findings:
- The same bit in two copies outvotes the good one.
- TMR cannot undo damage it never saw.
- The three copies landed on **adjacent physical pages** (two pages apart with the guard page), so one multi-cell upset or a failing chip could take out two copies at once.

## Hardware watchdog

cFS Health & Safety arms the watchdog at startup and services it every cycle. The stock Linux PSP's watchdog calls are empty, so `build/cfs/psp/cfe_psp_watchdog.c` sends them to the watchdog chip on `/dev/ttyS2`:

| Line | Meaning |
|---|---|
| `WS<ms>` | set timeout |
| `WE` / `WD` | enable / disable |
| `WK` | kick |

If no kick arrives in time, the chip power-cycles the computer. The v86 instance is destroyed and a new one boots, because v86's own `restart()` does not handle a bzImage boot. `init` starts cFS by itself when the kernel command line has `fsw=auto`.

## SD card: latent damage and boot loops

Every power-on boots from the SD card as it is at that moment. The filesystem image is kept uncompressed, so a hit damages one file instead of the whole archive:

| SD hit | Next boot |
|---|---|
| an unused file | normal |
| `cfs/cpu1/cf/sample_app.so` | cFS logs `Could not load file:/cf/sample_app.so`; everything else runs |
| `cfs/cpu1/core-cpu1` | the flight software cannot start; the watchdog resets again and again (boot loop), and FRAM counts the failed boots |
| ground restores the card | the next reset boots clean |

## OS adapters

The emulated hardware (`docs/js/hardware.js`) knows nothing about Linux or cFS. Everything OS-specific lives in an adapter, `docs/js/os/linux-cfs.js`: boot images, console patterns, telemetry decoding, memory-map categories. To try another OS, write another adapter and its small guest-side agents. The serial contract is in [`docs/js/os/README.md`](docs/js/os/README.md).

## Code layout

| Path | What |
|---|---|
| `docs/index.html` | page layout and styles |
| `docs/js/main.js` | wires the page together |
| `docs/js/hardware.js` | the flight computer: RAM + ECC + scrubber, SD card, FRAM, watchdog, serial ports, memory map |
| `docs/js/ecc.js` | SECDED (72,64) decoder |
| `docs/js/board3d.js` | 3D board, semantic zoom, picking, strikes along the line of sight |
| `docs/js/radiation.js` | particle track model, random directions and spectrum, background radiation and its statistics |
| `docs/js/missions.js` | the six missions |
| `docs/js/os/linux-cfs.js` | OS adapter for Linux + cFS |
| `docs/bzImage`, `initrd.gz` | Linux 6.8 (i386) and the root filesystem: busybox, 32-bit glibc, cFS with 13 apps + 2 libs |
| `docs/libv86.js`, `v86.wasm`, `bios.bin`, `vgabios.bin` | v86 0.5.470 and SeaBIOS |
| `docs/vendor/` | three.js r160 (MIT) |
| `build/` | kernel config, toolchain file, VM `init`, `serbridge.c`, `memmap.c`, cFS additions (`fault_inj`, `tmr_lib`, `tmr_calc`, PSP watchdog), `build-initrd.sh` |
| `test/` | VM tests in Node (`test-*.mjs`) and the page test in Chrome (`browser-lab.mjs`) |

## FAULT_INJ (software fault injection)

`build/cfs/apps/fault_inj` flips bits in other apps' memory on command, aimed by ELF segment or symbol. The page no longer uses it, since hits now go straight to the emulated hardware. It stays because it is what would work on real hardware, where nothing can flip memory from outside, and the VM tests use it.

| Code | Command | Payload (little-endian) |
|---|---|---|
| 0 | NOOP | none |
| 1 | RESET counters | none |
| 2 | QUERY memory map | `App[20]` |
| 3 | FLIP one byte | `App[20]`, `Region u8`, `BitMask u8`, `spare u16`, `Offset u32` |
| 4 | FLIP_RANDOM | `App[20]`, `Region u8`, `spare u8`, `Count u16`, `Seed u32` |
| 5 | FLIP_SYMBOL | `App[20]`, `Symbol[32]`, `Offset u32`, `BitMask u8`, `spare[3]` |
| 6 | SET_ECC | `Enabled u8`, `spare[3]` (a simpler software ECC model, VM tests only) |
| 7 | FLIP_TMR | `Region[20]`, `Copy u8`, `BitMask u8`, `spare u16`, `Offset u32` |

Commands go to MID `0x18C0`; housekeeping comes back on `0x08C0`. Regions: 0 code, 1 rodata, 2 data, 3 bss. App `CORE` targets the cFS executive.

Key result: 40 random hits in SAMPLE_APP's code crash **the whole flight software process**, Health & Safety included. cFS on Linux runs every app as a thread of one process, so there is no memory isolation between apps.

## Tests

| Test | Where | Result |
|---|---|---|
| `test/test-cfs.mjs` | Node + v86 | 12/12: boot, apps, threads, telemetry, commands, restart, reload |
| `test/test-fault.mjs` | Node + v86 | 15/15: FAULT_INJ |
| `test/test-watchdog.mjs` | Node + v86 | 9/9 |
| `test/test-tmr.mjs` | Node + v86 | 12/12 |
| `test/test-phys.mjs` | Node + v86 | 8/8: physical memory map, hits from outside |
| `test/browser-lab.mjs` | Chrome | 29/29 (below) |
| `test/test-ecc.mjs` | Node | 66/66: every 1-, 2- and 3-bit error |

`browser-lab.mjs` checks the following:
- Particle tracks: a light ion straight down flips 1 bit and one at 60° flips nothing; a heavy ion at 75° flips a line in one word along a row, and one bit in each of 8 words across rows (all corrected with ECC on).
- Background radiation: strikes land and the mission clock and dashboard run.
- Zooming to a TMR copy reaches readable bits, and a real click flips exactly the bit under the pointer.
- The vote repairs a flipped copy; with TMR off the answer goes wrong.
- Every ECC outcome: corrected, detected in free memory, silent 3-bit, scrub, ECC off revealing hidden errors, and a 2-bit machine check resetting the computer.
- The watchdog recovers a killed flight software.
- The particle shower lands its bits.
- An SD hit leads to a boot loop, and restoring the card recovers it.
- Missions 2 and 6 tick their goals off by themselves.

Run it with Playwright, serving `docs/` on port 8773: `CHROME=/path/to/chrome node test/browser-lab.mjs`.

## Gotchas found while porting

- **Kernel needs `CONFIG_RT_MUTEXES` and `CONFIG_COMPAT_32BIT_TIME`**, or OSAL's priority-inheritance mutexes fail with "Operation not supported".
- **TO_LAB sends telemetry to UDP 2234**, not 1235.
- **ES Reload only accepts cFS virtual paths** like `/cf/app.so`.
- **COM4 fails Linux's UART loopback test** in v86, so `init` declares it with `setserial /dev/ttyS3 uart 16550A`.
- **v86 always loads the initrd at 64 MB**, so 64 MB of RAM needs the image size added.
- **v86's `read_memory` returns a live view** of guest RAM: copy it before comparing later.
- **three.js (WebGL2) cannot resize a texture's storage**: a canvas texture that changes size needs a new texture.

## Rebuilding

Built on Ubuntu 24.04 with `gcc-multilib`. Copy the toolchain file into `sample_defs/`, then:

```
cmake -S cfe -B build-v86 -DSIMULATION=i686-v86 -DMISSIONCONFIG=sample -DCFE_EDS_ENABLED=OFF \
      -DCMAKE_BUILD_TYPE=release -DCMAKE_INSTALL_PREFIX=/exe -DENABLE_UNIT_TESTS=FALSE
make -C build-v86 mission-install
```

Then run `build/build-initrd.sh`. Libraries live only in `lib32/` and modules are stripped, which keeps the root filesystem at 7.7 MB.

*History:* an earlier version also had a three-computer TMR mode with an external voter and state resync (`save_state` / `restore_state`, ~0.6 s for a 39 MB snapshot). It was removed to keep the page focused on one computer; see the git history before the restructure.
