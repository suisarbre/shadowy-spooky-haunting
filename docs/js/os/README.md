# OS adapters

The emulated board (`../hardware.js`) is a 32-bit PC with 64 MB of RAM, an SD card, FRAM and a watchdog chip. It does not know what software it runs. An OS adapter tells it, and a few small programs inside the guest OS talk to the hardware over serial ports.

To try another OS (RTEMS, FreeRTOS's IA-32 port, Zephyr x86…), do two things:

1. Build a boot image for 32-bit x86 that v86 can load (bzImage + initrd, or a multiboot image with changes to `hardware.js`).
2. Write `my-os.js` next to `linux-cfs.js` with the same fields, implement the guest side of the contract below, and change the import in `../main.js`.

## The serial contract

| Port | Direction | Lines | Needed for |
|---|---|---|---|
| ttyS0 | both | free text console | boot and crash detection (the adapter's `patterns`) |
| ttyS1 | up | `C<hex>\n`: one command packet | ground commands |
| ttyS1 | down | `T<hex>\n`: one telemetry packet | telemetry (decoded by the adapter's `telemetry()`) |
| ttyS2 | down | `WS<ms>` timeout, `WE` enable, `WD` disable, `WK` kick | the watchdog (without it, the 30 s boot window expires and resets the board) |
| ttyS3 | up | `M\n`: request the memory map | page colours and labels (optional: without it, hits still work, unlabelled) |
| ttyS3 | down | `MB`, then `K <pfn> <n> <label>` (kernel) and `R <pfn> <n> <va> <pid> <comm> <label>` (process) lines in hex, then `ME` | |

`pfn` is a physical page number (4 KB pages), `n` a page count, `va` the virtual address of the first page. Earlier lines win when runs overlap, so list the most important owners first.

## The adapter's fields

| Field | What |
|---|---|
| `name` | shown nowhere yet; for humans |
| `images.kernel`, `images.rootfs` | files in `docs/` (a `.gz` rootfs is decompressed in the browser) |
| `cmdline` | kernel command line |
| `patterns` | regexes over the console: `fswStarting`, `shellReady`, `operational`, `fswExit`, `corruptExec`, `panic`, `probeDown`, `probeAlive` |
| `startCommand`, `probeCommand` | console commands: start the flight software; answer whether it is still alive (`probeAlive` / `probeDown`) |
| `onOperational(fc)` | called once the flight software is up (Linux + cFS: turn on the downlink) |
| `telemetry(fc, bytes)` | decode one telemetry packet into `fc.app`, log events with `fc.log`, emit `tmr-repair` / `calc-wrong` for the statistics |
| `freshApp()` | the empty `fc.app` state after each boot |
| `categorize(comm, label)` | memory-map run → colour key (`kernel`, `fsw`, `app`, `tmr1..3`, `lib`, `other`) |
| `categorizeFile(name)` | SD card file → colour key |
| `tmrLabel(k)` | memory-map label of TMR copy k (for the fly-to buttons) |
