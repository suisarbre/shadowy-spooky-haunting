/*
 * Lockstep backend for doomgeneric, shared by the satellite build (i386 Linux) and the
 * ground-station build (WebAssembly).
 *
 * Two copies of Doom given the same game data and the same input on the same tic compute the same
 * game, frame for frame: Doom's game logic is integer and fixed-point, and its "random" numbers
 * come from a fixed table. What breaks that is the wall clock. So here nothing reads it:
 *  - the game runs one tic per dg_step() call (Doom's -singletics mode),
 *  - the clock Doom sees is virtual: it advances 1/35 s per tic and by exactly the amount Doom asks
 *    to sleep (the screen-melt transition waits on it),
 *  - input arrives as a list of key events attached to a tic.
 * After each tic dg_step() returns a 32-bit hash of the frame, which the two sides compare.
 */
#include <stdint.h>
#include <string.h>
#include "doomgeneric.h"
#include "doomtype.h"

extern boolean singletics;

static uint32_t vclock_ms = 0;
uint32_t DG_GetTicksMs(void) { return vclock_ms; }
void DG_SleepMs(uint32_t ms) { vclock_ms += ms; }
void DG_SetWindowTitle(const char *title) { (void)title; }

#define QN 64
static unsigned char q_key[QN], q_down[QN];
static int q_head = 0, q_tail = 0;
int DG_GetKey(int *pressed, unsigned char *key) {
    if (q_head == q_tail) return 0;
    *pressed = q_down[q_head]; *key = q_key[q_head]; q_head = (q_head + 1) % QN;
    return 1;
}
void dg_key(int down, unsigned char key) {
    int n = (q_tail + 1) % QN; if (n == q_head) return;
    q_down[q_tail] = down ? 1 : 0; q_key[q_tail] = key; q_tail = n;
}

uint32_t dg_hash(void) {   /* FNV-1a over the displayed frame (palette applied) */
    const unsigned char *p = (const unsigned char *)DG_ScreenBuffer;
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < (size_t)DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4; i++) { h ^= p[i]; h *= 16777619u; }
    return h;
}

void dg_lockstep_init(void) { singletics = true; }

/* one game tic: queued keys are read inside, the frame is drawn, its hash returned */
uint32_t dg_step(void) {
    vclock_ms += 1000 / 35;
    doomgeneric_Tick();
    return dg_hash();
}
