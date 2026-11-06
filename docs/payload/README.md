# Doom payload

`doom-i386` (static i386 Linux, runs on the emulated satellite) and `doom-ground.wasm` (the ground station's copy) are built from [doomgeneric](https://github.com/ozkl/doomgeneric) at commit `e257a09527062bfb986b6e5e0780839b6cbd5b71`, plus the lockstep backends in `build/doom/`, by `build/doom/build-doom.sh`.

doomgeneric, and so these two binaries, are licensed under the GNU General Public License v2: see `LICENSE-doomgeneric.txt`. The complete source is the doomgeneric commit above together with `build/doom/` in this repository.

No game data is included. The page asks for a Doom IWAD file (the shareware `doom1.wad` works).
