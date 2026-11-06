/*
 * serbridge: links cFS (UDP on localhost) to the browser via a serial port.
 *   host -> VM : "C<hex>\n"  command packet, forwarded to CI_LAB (127.0.0.1:1234)
 *   VM -> host : "T<hex>\n"  telemetry packet received from TO_LAB on UDP 2234
 * Hex framing keeps the serial stream line-based and printable.
 *
 * File uplink (software updates from the ground), stored under /payload:
 *   host -> VM : "UB<name> <size> <crc32>"   begin a file (size and CRC-32 of the whole file, hex)
 *                "UD<seq>:<crc32>:<base64>"   one chunk, in order; its own CRC-32
 *                "UE"                          end: check size and CRC, then keep the file
 *   VM -> host : "UK<next seq>" chunk accepted · "UN<seq>" rejected, resend from seq ·
 *                "UA<name> ok|bad <crc32>"   file verified and stored, or discarded
 * Payload application (Doom), started and fed by the ground:
 *   host -> VM : "GS<args>" start /bin/payload-start <args> · "GQ" stop · "G<tic>:<keys>" one tic of input
 *   VM -> host : "P<line>" a line the payload printed · "PX<status>" the payload exited
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <termios.h>
#include <poll.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdint.h>

static int hexval(int c){ if(c>='0'&&c<='9')return c-'0'; c|=32; if(c>='a'&&c<='f')return c-'a'+10; return -1; }

static int tty;
static void say(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
#include <stdarg.h>
static void say(const char *fmt, ...) {
    char b[600]; va_list ap; va_start(ap, fmt); int n = vsnprintf(b, sizeof b - 1, fmt, ap); va_end(ap);
    if (n < 0) return;
    if (n > (int)sizeof b - 2) n = sizeof b - 2;
    b[n++] = '\n';
    for (int w = 0; w < n; ) { ssize_t r = write(tty, b + w, n - w); if (r > 0) w += r; }
}

static uint32_t crc_table[256];
static void crc_init(void) { for (uint32_t i = 0; i < 256; i++) { uint32_t c = i; for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1; crc_table[i] = c; } }
static uint32_t crc32_upd(uint32_t c, const unsigned char *p, size_t n) { c = ~c; while (n--) c = crc_table[(c ^ *p++) & 0xff] ^ (c >> 8); return ~c; }

static int b64v(int c) { if (c >= 'A' && c <= 'Z') return c - 'A'; if (c >= 'a' && c <= 'z') return c - 'a' + 26; if (c >= '0' && c <= '9') return c - '0' + 52; if (c == '+') return 62; if (c == '/') return 63; return -1; }
static size_t b64dec(const char *s, size_t n, unsigned char *out) {
    size_t o = 0; uint32_t acc = 0; int bits = 0;
    for (size_t i = 0; i < n; i++) { int v = b64v(s[i]); if (v < 0) continue; acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; } }
    return o;
}

/* ---- file uplink ---- */
static FILE *up_f; static char up_name[200], up_tmp[260]; static uint32_t up_size, up_crc, up_have_crc, up_seq, up_got;
static void uplink_line(char *l, size_t n) {
    if (l[1] == 'B') {
        if (up_f) fclose(up_f);
        char name[200]; unsigned sz = 0, crc = 0;
        if (sscanf(l + 2, "%199s %x %x", name, &sz, &crc) != 3 || strchr(name, '/')) { say("UAx bad 0"); return; }
        mkdir("/payload", 0755);
        snprintf(up_name, sizeof up_name, "%s", name); snprintf(up_tmp, sizeof up_tmp, "/payload/.%s.part", name);
        up_f = fopen(up_tmp, "wb"); up_size = sz; up_crc = crc; up_have_crc = 0; up_seq = 0; up_got = 0;
        say(up_f ? "UK0" : "UA%s bad 0", up_name);
    } else if (l[1] == 'D' && up_f) {
        char *c1 = strchr(l, ':'), *c2 = c1 ? strchr(c1 + 1, ':') : NULL;
        if (!c2) { say("UN%x", up_seq); return; }
        uint32_t seq = strtoul(l + 2, NULL, 16), crc = strtoul(c1 + 1, NULL, 16);
        static unsigned char buf[8192];
        size_t m = b64dec(c2 + 1, n - (size_t)(c2 + 1 - l), buf);
        if (seq != up_seq || crc32_upd(0, buf, m) != crc) { say("UN%x", up_seq); return; }
        fwrite(buf, 1, m, up_f); up_have_crc = crc32_upd(up_have_crc, buf, m); up_got += m; up_seq++;
        say("UK%x", up_seq);
    } else if (l[1] == 'E' && up_f) {
        fclose(up_f); up_f = NULL;
        char final[260]; snprintf(final, sizeof final, "/payload/%s", up_name);
        int ok = up_got == up_size && up_have_crc == up_crc;
        if (ok) rename(up_tmp, final); else unlink(up_tmp);
        say("UA%s %s %08x", up_name, ok ? "ok" : "bad", up_have_crc);
    }
}

/* ---- payload application ---- */
static pid_t pl_pid = -1; static int pl_in = -1, pl_out = -1;
static void payload_start(const char *args) {
    if (pl_pid > 0) { kill(pl_pid, SIGKILL); }
    int in[2], out[2]; if (pipe(in) || pipe(out)) return;
    pid_t pid = fork();
    if (pid == 0) {
        dup2(in[0], 0); dup2(out[1], 1); dup2(out[1], 2);
        close(in[1]); close(out[0]);
        execl("/bin/sh", "sh", "/bin/payload-start", args, (char *)NULL); _exit(127);
    }
    close(in[0]); close(out[1]); pl_pid = pid; pl_in = in[1]; pl_out = out[0];
    fcntl(pl_in, F_SETFL, O_NONBLOCK);
}

int main(int argc, char **argv) {
    const char *dev = argc > 1 ? argv[1] : "/dev/ttyS1";
    signal(SIGPIPE, SIG_IGN); crc_init();
    tty = open(dev, O_RDWR | O_NOCTTY);
    if (tty < 0) { perror("open tty"); return 1; }
    struct termios t; tcgetattr(tty, &t); cfmakeraw(&t); cfsetspeed(&t, B115200); tcsetattr(tty, TCSANOW, &t);

    int tlm = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(2234), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (bind(tlm, (struct sockaddr*)&a, sizeof a) < 0) { perror("bind 2234"); return 1; }
    int cmd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in ci = { .sin_family = AF_INET, .sin_port = htons(1234), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };

    static char line[8192]; size_t ll = 0;
    static unsigned char pkt[4096]; static char out[8200];
    fprintf(stderr, "serbridge: %s <-> udp cmd 1234 / tlm 2234\n", dev);
    write(tty, "B\n", 2); /* ready marker */
    for (;;) {
        struct pollfd p[3] = { { tty, POLLIN, 0 }, { tlm, POLLIN, 0 }, { pl_out, POLLIN, 0 } };
        if (poll(p, pl_out >= 0 ? 3 : 2, -1) < 0) continue;
        if (pl_out >= 0 && (p[2].revents & (POLLIN | POLLHUP))) {
            static char pb[4096]; static size_t pn = 0;
            ssize_t n = read(pl_out, pb + pn, sizeof pb - 1 - pn);
            if (n > 0) {
                pn += n;
                char *st = pb, *nl;
                while ((nl = memchr(st, '\n', pn - (st - pb)))) { *nl = 0; say("P%s", st); st = nl + 1; }
                pn -= st - pb; memmove(pb, st, pn);
                if (pn == sizeof pb - 1) pn = 0;
            } else {
                int status = 0; waitpid(pl_pid, &status, 0);
                say("PX%d", WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
                close(pl_out); close(pl_in); pl_out = pl_in = -1; pl_pid = -1; pn = 0;
            }
        }
        if (p[1].revents & POLLIN) {
            ssize_t n = recv(tlm, pkt, sizeof pkt, 0);
            if (n > 0) {
                static const char *hx = "0123456789abcdef";
                size_t o = 0; out[o++] = 'T';
                for (ssize_t i = 0; i < n; i++) { out[o++] = hx[pkt[i] >> 4]; out[o++] = hx[pkt[i] & 15]; }
                out[o++] = '\n';
                for (size_t w = 0; w < o; ) { ssize_t r = write(tty, out + w, o - w); if (r > 0) w += r; }
            }
        }
        if (p[0].revents & POLLIN) {
            char buf[512]; ssize_t n = read(tty, buf, sizeof buf);
            for (ssize_t i = 0; i < n; i++) {
                if (buf[i] == '\n' || buf[i] == '\r') {
                    line[ll] = 0;
                    if (ll > 1 && line[0] == 'U') uplink_line(line, ll);
                    else if (ll > 1 && line[0] == 'G' && line[1] == 'S') payload_start(line + 2);
                    else if (ll > 1 && line[0] == 'G' && line[1] == 'Q') { if (pl_pid > 0) kill(pl_pid, SIGKILL); }
                    else if (ll > 1 && line[0] == 'G' && pl_in >= 0) { line[ll] = '\n'; (void)!write(pl_in, line, ll + 1); }
                    else if (ll > 1 && line[0] == 'C') {
                        size_t m = 0;
                        for (size_t j = 1; j + 1 < ll && m < sizeof pkt; j += 2) {
                            int h = hexval(line[j]), l = hexval(line[j+1]);
                            if (h < 0 || l < 0) break;
                            pkt[m++] = (h << 4) | l;
                        }
                        sendto(cmd, pkt, m, 0, (struct sockaddr*)&ci, sizeof ci);
                    }
                    ll = 0;
                } else if (ll < sizeof line - 1) line[ll++] = buf[i];
            }
        }
    }
}
