/*
 * memmap: answers "which physical page belongs to whom" for the browser.
 *
 * Runs as a daemon on /dev/ttyS3 (a diagnostic port, separate from the radio
 * link). When the host sends "M\n" it walks every process's /proc/<pid>/maps
 * and /proc/<pid>/pagemap, plus /proc/iomem for the kernel image, and writes:
 *   MB                                         begin
 *   K <pfn> <count> <label>                    kernel image ranges
 *   R <pfn> <count> <vaddr> <pid> <comm> <label>   runs of physically and virtually contiguous pages
 *   ME <pages-mapped>                          end
 * Numbers are hex. Labels: <module>:code|rodata|data, bss, heap, stack, anon,
 * and "tmr:<region>:<copy>" for TMR_LIB partitions (from /tmp/tmr_regions).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>

#define PAGE 4096u

static FILE *out;
typedef struct { char name[24]; unsigned copy; unsigned long va, size; } Tmr;
static Tmr tmr[32]; static int ntmr;

static void load_tmr(void)
{
    ntmr = 0;
    FILE *f = fopen("/tmp/tmr_regions", "r"); if (!f) return;
    while (ntmr < 32 && fscanf(f, "%23s %u %lx %lx", tmr[ntmr].name, &tmr[ntmr].copy, &tmr[ntmr].va, &tmr[ntmr].size) == 4) ntmr++;
    fclose(f);
}

static const char *base(const char *p) { const char *s = strrchr(p, '/'); return s ? s + 1 : p; }

/* one run of pages that are contiguous both virtually and physically */
static uint64_t run_pfn, run_n; static unsigned long run_va; static int run_pid; static char run_comm[20], run_label[64];
static unsigned long mapped;
static void flush(void)
{
    if (run_n) fprintf(out, "R %llx %llx %lx %x %s %s\n", (unsigned long long)run_pfn, (unsigned long long)run_n, run_va, run_pid, run_comm, run_label);
    run_n = 0;
}
static void add(uint64_t pfn, unsigned long va, int pid, const char *comm, const char *label)
{
    mapped++;
    if (run_n && pid == run_pid && pfn == run_pfn + run_n && va == run_va + run_n * PAGE && strcmp(label, run_label) == 0) { run_n++; return; }
    flush();
    run_pfn = pfn; run_n = 1; run_va = va; run_pid = pid;
    snprintf(run_comm, sizeof run_comm, "%s", comm); snprintf(run_label, sizeof run_label, "%s", label);
    for (char *c = run_label; *c; c++) if (*c == ' ') *c = '_';   /* e.g. "/SYSV... (deleted)" */
}

static void scan_pid(int pid)
{
    char path[64], comm[20] = "?", line[512];
    snprintf(path, sizeof path, "/proc/%d/comm", pid);
    FILE *cf = fopen(path, "r"); if (cf) { if (fgets(comm, sizeof comm, cf)) comm[strcspn(comm, "\n")] = 0; fclose(cf); }
    for (char *c = comm; *c; c++) if (*c == ' ') *c = '_';
    snprintf(path, sizeof path, "/proc/%d/maps", pid);
    FILE *mf = fopen(path, "r"); if (!mf) return;
    snprintf(path, sizeof path, "/proc/%d/pagemap", pid);
    int pm = open(path, O_RDONLY); if (pm < 0) { fclose(mf); return; }
    char prev_module[64] = "";
    while (fgets(line, sizeof line, mf)) {
        unsigned long lo, hi; char perm[8], file[256] = "";
        if (sscanf(line, "%lx-%lx %7s %*s %*s %*s %255[^\n]", &lo, &hi, perm, file) < 3) continue;
        char *f = file; while (*f == ' ') f++;
        char label[64];
        if (*f == '/') {
            snprintf(prev_module, sizeof prev_module, "%s", base(f));
            snprintf(label, sizeof label, "%s:%s", prev_module, perm[2] == 'x' ? "code" : perm[1] == 'w' ? "data" : "rodata");
        } else if (strcmp(f, "[heap]") == 0) snprintf(label, sizeof label, "heap");
        else if (strncmp(f, "[stack", 6) == 0) snprintf(label, sizeof label, "stack");
        else if (*f == '[') continue;   /* vdso, vvar */
        else if (perm[1] == 'w' && prev_module[0]) { snprintf(label, sizeof label, "%s:bss", prev_module); prev_module[0] = 0; }
        else snprintf(label, sizeof label, "anon");
        for (unsigned long va = lo; va < hi; va += PAGE) {
            uint64_t e;
            if (pread(pm, &e, 8, (off_t)(va / PAGE) * 8) != 8) break;
            if (!(e >> 63)) continue;                       /* not present in RAM */
            uint64_t pfn = e & ((1ULL << 55) - 1);
            if (!pfn) continue;
            const char *l = label; char tl[64];
            for (int i = 0; i < ntmr; i++)
                if (va >= tmr[i].va && va < tmr[i].va + ((tmr[i].size + PAGE - 1) & ~(PAGE - 1))) { snprintf(tl, sizeof tl, "tmr:%s:%u", tmr[i].name, tmr[i].copy + 1); l = tl; }
            add(pfn, va, pid, comm, l);
        }
        flush();
        if (*f != '/' && perm[1] != 'w') prev_module[0] = 0;
    }
    flush();
    close(pm); fclose(mf);
}

static void dump(void)
{
    mapped = 0; load_tmr();
    fprintf(out, "MB\n");
    FILE *io = fopen("/proc/iomem", "r");
    char line[256];
    if (io) {
        while (fgets(line, sizeof line, io)) {
            unsigned long lo, hi; char what[128];
            if (sscanf(line, " %lx-%lx : %127[^\n]", &lo, &hi, what) == 3 && strncmp(what, "Kernel ", 7) == 0) {
                for (char *c = what; *c; c++) if (*c == ' ') *c = '_';
                fprintf(out, "K %lx %lx %s\n", lo / PAGE, (hi - lo + 1 + PAGE - 1) / PAGE, what);
            }
        }
        fclose(io);
    }
    /* cFS first, so shared pages are credited to the flight software */
    int pids[512], n = 0, cfs = -1;
    DIR *d = opendir("/proc"); struct dirent *de;
    while (d && (de = readdir(d)) && n < 512) { int p = atoi(de->d_name); if (p > 0) pids[n++] = p; }
    if (d) closedir(d);
    for (int i = 0; i < n; i++) {
        char path[64], comm[32] = ""; snprintf(path, sizeof path, "/proc/%d/comm", pids[i]);
        FILE *cf = fopen(path, "r"); if (cf) { if (fgets(comm, sizeof comm, cf)) {} fclose(cf); }
        if (strncmp(comm, "core-cpu1", 9) == 0) { cfs = pids[i]; scan_pid(cfs); }
    }
    for (int i = 0; i < n; i++) if (pids[i] != cfs) scan_pid(pids[i]);
    fprintf(out, "ME %lx\n", mapped);
    fflush(out);
}

int main(int argc, char **argv)
{
    if (argc > 1 && strcmp(argv[1], "-") == 0) { out = stdout; dump(); return 0; }   /* one-shot to stdout */
    const char *dev = argc > 1 ? argv[1] : "/dev/ttyS3";
    int fd = open(dev, O_RDWR | O_NOCTTY);
    if (fd < 0) { perror(dev); return 1; }
    struct termios t; if (tcgetattr(fd, &t) == 0) { cfmakeraw(&t); tcsetattr(fd, TCSANOW, &t); }
    out = fdopen(dup(fd), "w");
    char buf[64];
    for (;;) {
        ssize_t r = read(fd, buf, sizeof buf);
        if (r <= 0) { usleep(100000); continue; }
        for (ssize_t i = 0; i < r; i++) if (buf[i] == 'M') dump();
    }
}
