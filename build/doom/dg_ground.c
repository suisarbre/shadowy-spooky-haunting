/*
 * Ground-station side: the same Doom built for WebAssembly, run in the page. The page calls
 * dg_create() once, then dg_key() for each input event and dg_step() once per tic, and reads the
 * frame from dg_screen() (320x200 RGBA, palette applied). It is the reference the satellite's
 * frame hashes are checked against.
 */
#include <stdint.h>
#include "doomgeneric.h"

void dg_key(int down, unsigned char key);
uint32_t dg_step(void);
uint32_t dg_hash(void);
void dg_lockstep_init(void);

void DG_Init(void) { dg_lockstep_init(); }
void DG_DrawFrame(void) {}

static char iwad[256];
__attribute__((export_name("dg_iwad_buf"))) char *dg_iwad_buf(void) { return iwad; }
__attribute__((export_name("dg_create"))) uint32_t dg_create(void) {
    static char *argv[] = { "doom", "-iwad", iwad, 0 };
    doomgeneric_Create(3, argv);
    return dg_hash();
}
__attribute__((export_name("dg_keyev"))) void dg_keyev(int down, int key) { dg_key(down, (unsigned char)key); }
__attribute__((export_name("dg_tick"))) uint32_t dg_tick(void) { return dg_step(); }
__attribute__((export_name("dg_screen"))) uint32_t *dg_screen(void) { return (uint32_t *)DG_ScreenBuffer; }

/* WASI has no processes; Doom only uses system() to pop up an error dialog */
int system(const char *cmd) { (void)cmd; return -1; }
