#!/bin/sh
# Build the Doom payload twice from one source: for the satellite (static i386 Linux) and for the
# ground station (WebAssembly). doomgeneric is GPLv2: https://github.com/ozkl/doomgeneric
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
W=${W:-/home/claude/work/doom}
OUT=${OUT:-$HERE/../../docs/payload}
WASI=${WASI:-$W/wasi}
REV=e257a09527062bfb986b6e5e0780839b6cbd5b71
[ -d $W/doomgeneric ] || git clone -q https://github.com/ozkl/doomgeneric.git $W/doomgeneric
( cd $W/doomgeneric && git checkout -q $REV )
SRC=$W/build-src && rm -rf $SRC && cp -r $W/doomgeneric/doomgeneric $SRC
# the satellite reads the palette to program the VGA DAC
sed -i 's/^static struct color colors\[256\];/struct color colors[256];/' $SRC/i_video.c
cp $HERE/dg_lockstep.c $HERE/dg_sat.c $HERE/dg_ground.c $SRC/
CORE=$(cd $SRC && ls *.c | grep -vE '^doomgeneric_|^dg_|^i_(sdl|allegro)|^i_cdmus' | tr '\n' ' ')
DEFS="-DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -DNORMALUNIX -DLINUX"
mkdir -p $OUT
# clang looks for the wasm compiler runtime in its resource dir: make one that has it
RD=$WASI/resource-dir
[ -f $RD/lib/wasi/libclang_rt.builtins-wasm32.a ] || { rm -rf $RD; cp -r "$(clang -print-resource-dir)" $RD; mkdir -p $RD/lib/wasi; cp $WASI/libclang_rt.builtins-wasm32-wasi-24.0/libclang_rt.builtins-wasm32.a $RD/lib/wasi/; }
( cd $SRC && gcc -m32 -static -O2 -fno-strict-aliasing -w $DEFS -o $OUT/doom-i386 $CORE dg_lockstep.c dg_sat.c -lm && strip $OUT/doom-i386 )
( cd $SRC && clang -resource-dir=$RD --target=wasm32-wasi --sysroot=$WASI/wasi-sysroot-24.0 -mexec-model=reactor -O2 -fno-strict-aliasing -w $DEFS \
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS \
    -Wl,--export=malloc -Wl,--export-memory -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 \
    -o $OUT/doom-ground.wasm $CORE dg_lockstep.c dg_ground.c \
    -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks )
ls -la $OUT/doom-i386 $OUT/doom-ground.wasm
