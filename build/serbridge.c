/*
 * serbridge: links cFS (UDP on localhost) to the browser via a serial port.
 *   host -> VM : "C<hex>\n"  command packet, forwarded to CI_LAB (127.0.0.1:1234)
 *   VM -> host : "T<hex>\n"  telemetry packet received from TO_LAB on UDP 2234
 * Hex framing keeps the serial stream line-based and printable.
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

static int hexval(int c){ if(c>='0'&&c<='9')return c-'0'; c|=32; if(c>='a'&&c<='f')return c-'a'+10; return -1; }

int main(int argc, char **argv) {
    const char *dev = argc > 1 ? argv[1] : "/dev/ttyS1";
    int tty = open(dev, O_RDWR | O_NOCTTY);
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
        struct pollfd p[2] = { { tty, POLLIN, 0 }, { tlm, POLLIN, 0 } };
        if (poll(p, 2, -1) < 0) continue;
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
                    if (ll > 1 && line[0] == 'C') {
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
