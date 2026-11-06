/*
 * Satellite side: Doom as a payload application on the flight computer (i386 Linux).
 *
 * The ground uplinks one line per tic on stdin (relayed by serbridge from the command link):
 *     G<tic>:<dd><kk>...      tic in hex, then key events: dd = 01 down / 00 up, kk = Doom key code
 * After running that tic it answers on stdout with the frame hash, relayed to the ground:
 *     @@D<tic>:<hash>
 * The frame also goes to the computer's VGA in mode 13h (320x200, 256 colours: Doom's own format),
 * so the emulator's screen shows what the satellite computed.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/io.h>
#include <sys/mman.h>
#include "doomgeneric.h"
#include "doomtype.h"

void dg_key(int down, unsigned char key);
uint32_t dg_step(void);
uint32_t dg_hash(void);
void dg_lockstep_init(void);
#include "i_video.h"
extern byte *I_VideoBuffer;
extern struct color colors[256];   /* made non-static by build-doom.sh */

static volatile unsigned char *vga = NULL;
static struct color shown[256];

static void vga_mode13(void) {
    static const unsigned char seq[5] = { 0x03, 0x01, 0x0F, 0x00, 0x0E };
    static const unsigned char crtc[25] = { 0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0xBF, 0x1F, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                            0x9C, 0x0E, 0x8F, 0x28, 0x40, 0x96, 0xB9, 0xA3, 0xFF };
    static const unsigned char gc[9] = { 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x05, 0x0F, 0xFF };
    static const unsigned char ac[21] = { 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
                                          0x41, 0x00, 0x0F, 0x00, 0x00 };
    outb(0x63, 0x3C2);
    for (int i = 0; i < 5; i++) { outb(i, 0x3C4); outb(seq[i], 0x3C5); }
    outb(0x11, 0x3D4); outb(inb(0x3D5) & 0x7F, 0x3D5);          /* unlock CRTC 0-7 */
    for (int i = 0; i < 25; i++) { outb(i, 0x3D4); outb(crtc[i], 0x3D5); }
    for (int i = 0; i < 9; i++) { outb(i, 0x3CE); outb(gc[i], 0x3CF); }
    for (int i = 0; i < 21; i++) { (void)inb(0x3DA); outb(i, 0x3C0); outb(ac[i], 0x3C0); }
    (void)inb(0x3DA); outb(0x20, 0x3C0);                         /* display on */
}

void DG_Init(void) {
    dg_lockstep_init();
    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd >= 0 && iopl(3) == 0) {
        void *m = mmap(NULL, 65536, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0xA0000);
        if (m != MAP_FAILED) { vga = m; vga_mode13(); }
    }
    if (!vga) fprintf(stderr, "doom: no VGA (needs /dev/mem and iopl); running headless\n");
    memset(shown, 0xff, sizeof shown);
}

void DG_DrawFrame(void) {
    if (!vga) return;
    if (memcmp(shown, colors, sizeof shown)) {
        memcpy(shown, colors, sizeof shown);
        outb(0, 0x3C8);
        for (int i = 0; i < 256; i++) { outb(colors[i].r >> 2, 0x3C9); outb(colors[i].g >> 2, 0x3C9); outb(colors[i].b >> 2, 0x3C9); }
    }
    memcpy((void *)vga, I_VideoBuffer, 320 * 200);
}

static int hx(int c) { if (c >= '0' && c <= '9') return c - '0'; c |= 32; return (c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1; }

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    doomgeneric_Create(argc, argv);
    printf("@@R%08x\n", (unsigned)dg_hash());           /* ready, with the hash of the first frame */
    char line[1024];
    while (fgets(line, sizeof line, stdin)) {
        if (line[0] != 'G') continue;
        char *c = strchr(line, ':'); if (!c) continue;
        unsigned tic = (unsigned)strtoul(line + 1, NULL, 16);
        for (char *p = c + 1; hx(p[0]) >= 0 && hx(p[1]) >= 0 && hx(p[2]) >= 0 && hx(p[3]) >= 0; p += 4)
            dg_key(hx(p[0]) * 16 + hx(p[1]), (unsigned char)(hx(p[2]) * 16 + hx(p[3])));
        printf("@@D%x:%08x\n", tic, (unsigned)dg_step());
    }
    return 0;
}
