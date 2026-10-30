/*
 * FAULT_INJ - radiation upset simulator for the SpaceY cFS demo.
 *
 * Flips bits in the memory of other cFS apps (or the cFS core executive)
 * on command, the way a single-event upset would. Targets are named by app,
 * so a browser-side "beam" can hit the same spot reproducibly.
 *
 * Memory regions of a target are found from its loaded ELF segments:
 *   code   - executable segment
 *   rodata - read-only data
 *   data   - initialized writable data
 *   bss    - zero-initialized writable data (most app state lives here)
 * Read-only or executable pages are briefly made writable to apply the flip,
 * then restored, so code corruption behaves like a real upset in ROM/RAM.
 *
 * Simulated ECC (error-correcting memory), off by default like the emulated PC:
 *   on  - a single-bit hit is corrected before software sees it (memory unchanged,
 *         counted and reported); a multi-bit hit in one byte is detected but
 *         uncorrectable, so the data is corrupted and a critical event is raised
 *   off - every hit lands in memory
 * Corrections are treated as immediate, i.e. reads or scrubbing catch a flip
 * before a second one accumulates in the same word.
 *
 * Commands (MID 0x18C0):  0 NOOP, 1 RESET, 2 QUERY, 3 FLIP, 4 FLIP_RANDOM, 5 FLIP_SYMBOL, 6 SET_ECC,
 *                         7 FLIP_TMR (one copy of a TMR_LIB region)
 * Telemetry (MID 0x08C0): housekeeping after every command and once a second
 */
#define _GNU_SOURCE
#include <link.h>
#include <dlfcn.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/mman.h>

#include "cfe.h"
#include "tmr_lib.h"

#define FAULT_INJ_CMD_MID 0x18C0
#define FAULT_INJ_HK_MID  0x08C0

#define FAULT_INJ_NOOP_CC        0
#define FAULT_INJ_RESET_CC       1
#define FAULT_INJ_QUERY_CC       2
#define FAULT_INJ_FLIP_CC        3
#define FAULT_INJ_FLIP_RANDOM_CC 4
#define FAULT_INJ_FLIP_SYMBOL_CC 5
#define FAULT_INJ_SET_ECC_CC     6
#define FAULT_INJ_FLIP_TMR_CC    7

enum { REG_CODE = 0, REG_RODATA = 1, REG_DATA = 2, REG_BSS = 3, REG_COUNT = 4 };
static const char *RegName[REG_COUNT] = {"code", "rodata", "data", "bss"};

/* Event IDs */
enum { EID_INIT = 1, EID_NOOP, EID_RESET, EID_QUERY, EID_FLIP, EID_ERR, EID_CMD_ERR, EID_ECC_MODE, EID_ECC_CORRECTED, EID_ECC_UNCORRECTABLE };

/* ---- command payloads (little-endian, packed to match the browser encoder) ---- */
typedef struct { CFE_MSG_CommandHeader_t Hdr; } FAULT_INJ_NoArgsCmd_t;
typedef struct { CFE_MSG_CommandHeader_t Hdr; char App[20]; } FAULT_INJ_QueryCmd_t;
typedef struct {
    CFE_MSG_CommandHeader_t Hdr;
    char   App[20];
    uint8  Region;   /* REG_* */
    uint8  BitMask;  /* bits to flip in the target byte */
    uint16 Spare;
    uint32 Offset;   /* byte offset into the region (wrapped to region size) */
} FAULT_INJ_FlipCmd_t;
typedef struct {
    CFE_MSG_CommandHeader_t Hdr;
    char   App[20];
    uint8  Region;
    uint8  Spare;
    uint16 Count;    /* number of single-bit flips */
    uint32 Seed;     /* 0 = use a time-based seed */
} FAULT_INJ_FlipRandomCmd_t;
typedef struct {
    CFE_MSG_CommandHeader_t Hdr;
    char   App[20];
    char   Symbol[32]; /* global variable or function name in the target module */
    uint32 Offset;
    uint8  BitMask;
    uint8  Spare[3];
} FAULT_INJ_FlipSymbolCmd_t;
typedef struct {
    CFE_MSG_CommandHeader_t Hdr;
    uint8 Enabled;   /* 1 = ECC on, 0 = off */
    uint8 Spare[3];
} FAULT_INJ_SetEccCmd_t;
typedef struct {
    CFE_MSG_CommandHeader_t Hdr;
    char   Region[20]; /* TMR region name, e.g. "CALC" */
    uint8  Copy;       /* 0, 1 or 2 */
    uint8  BitMask;
    uint16 Spare;
    uint32 Offset;     /* byte offset into the copy (wrapped to its size) */
} FAULT_INJ_FlipTmrCmd_t;

/* ---- housekeeping telemetry ---- */
typedef struct {
    CFE_MSG_TelemetryHeader_t Hdr;
    uint8  CmdCounter;
    uint8  ErrCounter;
    uint16 Spare;
    uint32 TotalBitsFlipped;
    uint32 LastAddress;
    char   LastApp[20];
    uint8  LastRegion;
    uint8  LastOldByte;
    uint8  LastNewByte;
    uint8  Spare2;
    uint8  EccEnabled;
    uint8  Spare3[3];
    uint32 EccCorrected;      /* single-bit hits corrected by ECC */
    uint32 EccUncorrectable;  /* multi-bit hits detected but not correctable */
} FAULT_INJ_HkTlm_t;

static struct {
    CFE_SB_PipeId_t   Pipe;
    FAULT_INJ_HkTlm_t Hk;
    uint32            Rng;
} FI;

typedef struct { uintptr_t Addr[REG_COUNT]; size_t Size[REG_COUNT]; char Path[128]; } Regions_t;

/* ---------------------------------------------------------------- */
/* Region discovery                                                  */
/* ---------------------------------------------------------------- */
typedef struct { const char *Want; Regions_t *Out; int Found; } FindCtx_t;

static const char *base_name(const char *p) { const char *s = strrchr(p, '/'); return s ? s + 1 : p; }

static int find_cb(struct dl_phdr_info *info, size_t size, void *arg)
{
    FindCtx_t *ctx = arg;
    const char *name = info->dlpi_name ? info->dlpi_name : "";
    (void)size;
    /* "" is the main executable (the cFS core); otherwise match the .so file name */
    if (ctx->Want[0] == 0 ? name[0] != 0 : strcmp(base_name(name), ctx->Want) != 0)
        return 0;
    memset(ctx->Out, 0, sizeof(*ctx->Out));
    snprintf(ctx->Out->Path, sizeof(ctx->Out->Path), "%s", name);
    for (int i = 0; i < info->dlpi_phnum; i++) {
        const ElfW(Phdr) *ph = &info->dlpi_phdr[i];
        if (ph->p_type != PT_LOAD) continue;
        uintptr_t a = info->dlpi_addr + ph->p_vaddr;
        if (ph->p_flags & PF_X) {
            if (!ctx->Out->Size[REG_CODE]) { ctx->Out->Addr[REG_CODE] = a; ctx->Out->Size[REG_CODE] = ph->p_memsz; }
        } else if (ph->p_flags & PF_W) {
            ctx->Out->Addr[REG_DATA] = a; ctx->Out->Size[REG_DATA] = ph->p_filesz;
            if (ph->p_memsz > ph->p_filesz) { ctx->Out->Addr[REG_BSS] = a + ph->p_filesz; ctx->Out->Size[REG_BSS] = ph->p_memsz - ph->p_filesz; }
        } else if (ph->p_flags & PF_R) {
            /* first R-only segment usually holds ELF headers; prefer the one after code */
            if (ctx->Out->Size[REG_CODE] || !ctx->Out->Size[REG_RODATA]) { ctx->Out->Addr[REG_RODATA] = a; ctx->Out->Size[REG_RODATA] = ph->p_memsz; }
        }
    }
    ctx->Found = 1;
    return 1;
}

/* App name -> memory regions. "CORE" targets the cFS executive itself. */
static int32 FindRegions(const char *app, Regions_t *out)
{
    char want[CFE_MISSION_MAX_PATH_LEN] = "";
    if (strcmp(app, "CORE") != 0) {
        CFE_ES_AppId_t   id;
        CFE_ES_AppInfo_t info;
        if (CFE_ES_GetAppIDByName(&id, app) != CFE_SUCCESS || CFE_ES_GetAppInfo(&info, id) != CFE_SUCCESS)
            return -1;
        snprintf(want, sizeof(want), "%s", base_name(info.FileName));
    }
    FindCtx_t ctx = { want, out, 0 };
    dl_iterate_phdr(find_cb, &ctx);
    return ctx.Found ? 0 : -2;
}

/* ---------------------------------------------------------------- */
/* The actual upset                                                  */
/* ---------------------------------------------------------------- */
static int page_prot(uintptr_t addr)
{
    FILE *f = fopen("/proc/self/maps", "r");
    char line[256]; int prot = -1;
    if (!f) return -1;
    while (fgets(line, sizeof line, f)) {
        unsigned long lo, hi; char p[5];
        if (sscanf(line, "%lx-%lx %4s", &lo, &hi, p) == 3 && addr >= lo && addr < hi) {
            prot = (p[0] == 'r' ? PROT_READ : 0) | (p[1] == 'w' ? PROT_WRITE : 0) | (p[2] == 'x' ? PROT_EXEC : 0);
            break;
        }
    }
    fclose(f);
    return prot;
}

typedef enum { HIT_LANDED = 0, HIT_CORRECTED = 1, HIT_UNCORRECTABLE = 2 } HitResult_t;

/* Apply one radiation hit to a byte, passing it through the simulated ECC.
 * Returns <0 on failure, otherwise a HitResult_t. */
static int32 FlipByte(uintptr_t addr, uint8 mask, uint8 *oldv, uint8 *newv)
{
    int nbits = __builtin_popcount(mask);
    FI.Hk.TotalBitsFlipped += nbits;
    FI.Hk.LastAddress = (uint32)addr;
    if (FI.Hk.EccEnabled && nbits == 1) {
        /* corrected on the next read/scrub: software never sees the bad bit */
        *oldv = *newv = *(volatile uint8 *)addr;
        FI.Hk.LastOldByte = *oldv; FI.Hk.LastNewByte = *newv;
        FI.Hk.EccCorrected++;
        return HIT_CORRECTED;
    }
    int prot = page_prot(addr);
    if (prot < 0) return -1;
    long      pg   = sysconf(_SC_PAGESIZE);
    uintptr_t page = addr & ~(uintptr_t)(pg - 1);
    if (!(prot & PROT_WRITE) && mprotect((void *)page, pg, prot | PROT_WRITE | PROT_READ) != 0) return -2;
    volatile uint8 *p = (volatile uint8 *)addr;
    *oldv = *p;
    *p    = *oldv ^ mask;
    *newv = *p;
    if (!(prot & PROT_WRITE)) mprotect((void *)page, pg, prot);
    FI.Hk.LastOldByte = *oldv; FI.Hk.LastNewByte = *newv;
    if (FI.Hk.EccEnabled) { FI.Hk.EccUncorrectable++; return HIT_UNCORRECTABLE; }
    return HIT_LANDED;
}

/* Report a hit, worded by what the ECC did with it. */
static void ReportHit(int32 res, const char *how, const char *app, const char *where, unsigned long off, uintptr_t addr, uint8 o, uint8 n, uint8 mask)
{
    if (res == HIT_CORRECTED)
        CFE_EVS_SendEvent(EID_ECC_CORRECTED, CFE_EVS_EventType_INFORMATION, "ECC corrected 1-bit %s hit in %s %s+0x%lx @%lx", how, app, where, off, (unsigned long)addr);
    else if (res == HIT_UNCORRECTABLE)
        CFE_EVS_SendEvent(EID_ECC_UNCORRECTABLE, CFE_EVS_EventType_CRITICAL, "ECC UNCORRECTABLE %d-bit %s hit in %s %s+0x%lx @%lx: %02x->%02x",
                          __builtin_popcount(mask), how, app, where, off, (unsigned long)addr, o, n);
    else
        CFE_EVS_SendEvent(EID_FLIP, CFE_EVS_EventType_INFORMATION, "%s hit %s %s+0x%lx @%lx: %02x->%02x", how, app, where, off, (unsigned long)addr, o, n);
}

static uint32 Rand(void) { FI.Rng ^= FI.Rng << 13; FI.Rng ^= FI.Rng >> 17; FI.Rng ^= FI.Rng << 5; return FI.Rng; }

static void SendHk(void) { CFE_SB_TimeStampMsg(CFE_MSG_PTR(FI.Hk.Hdr)); CFE_SB_TransmitMsg(CFE_MSG_PTR(FI.Hk.Hdr), true); }

static void CopyName(char *dst, const char *src, size_t n) { memcpy(dst, src, n); dst[n - 1] = 0; }

/* ---------------------------------------------------------------- */
/* Command handlers                                                  */
/* ---------------------------------------------------------------- */
static bool Query(const FAULT_INJ_QueryCmd_t *c)
{
    char app[20]; Regions_t r; CopyName(app, c->App, sizeof app);
    if (FindRegions(app, &r) != 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "QUERY: app %s not found", app); return false; }
    CFE_EVS_SendEvent(EID_QUERY, CFE_EVS_EventType_INFORMATION,
                      "%s code=%lx+%lu rodata=%lx+%lu data=%lx+%lu bss=%lx+%lu", app,
                      (unsigned long)r.Addr[0], (unsigned long)r.Size[0], (unsigned long)r.Addr[1], (unsigned long)r.Size[1],
                      (unsigned long)r.Addr[2], (unsigned long)r.Size[2], (unsigned long)r.Addr[3], (unsigned long)r.Size[3]);
    return true;
}

static bool FlipAt(const char *app, uint8 region, uint32 offset, uint8 mask, const char *how)
{
    Regions_t r; uint8 o, n;
    if (region >= REG_COUNT || mask == 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "bad region %u or empty mask", region); return false; }
    if (FindRegions(app, &r) != 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "%s: app %s not found", how, app); return false; }
    if (r.Size[region] == 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "%s: %s has no %s region", how, app, RegName[region]); return false; }
    uintptr_t addr = r.Addr[region] + (offset % r.Size[region]);
    int32 res = FlipByte(addr, mask, &o, &n);
    if (res < 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "%s: cannot write %lx", how, (unsigned long)addr); return false; }
    CopyName(FI.Hk.LastApp, app, sizeof FI.Hk.LastApp); FI.Hk.LastRegion = region;
    ReportHit(res, how, app, RegName[region], (unsigned long)(addr - r.Addr[region]), addr, o, n, mask);
    return true;
}

static bool Flip(const FAULT_INJ_FlipCmd_t *c)
{
    char app[20]; CopyName(app, c->App, sizeof app);
    return FlipAt(app, c->Region, c->Offset, c->BitMask, "FLIP");
}

static bool FlipRandom(const FAULT_INJ_FlipRandomCmd_t *c)
{
    char app[20]; CopyName(app, c->App, sizeof app);
    uint16 count = c->Count ? c->Count : 1;
    if (count > 256) count = 256;
    FI.Rng = c->Seed ? c->Seed : (uint32)CFE_TIME_GetTime().Subseconds ^ 0x9E3779B9u;
    for (uint16 i = 0; i < count; i++)
        if (!FlipAt(app, c->Region, Rand(), (uint8)(1u << (Rand() & 7)), "RANDOM")) return false;
    return true;
}

static bool FlipSymbol(const FAULT_INJ_FlipSymbolCmd_t *c)
{
    char app[20], sym[32]; Regions_t r; uint8 o, n;
    CopyName(app, c->App, sizeof app); CopyName(sym, c->Symbol, sizeof sym);
    if (FindRegions(app, &r) != 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "SYMBOL: app %s not found", app); return false; }
    void *h = r.Path[0] ? dlopen(r.Path, RTLD_NOW | RTLD_NOLOAD) : dlopen(NULL, RTLD_NOW);
    void *a = h ? dlsym(h, sym) : NULL;
    if (h) dlclose(h);
    if (!a) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "SYMBOL: %s not found in %s", sym, app); return false; }
    uintptr_t addr = (uintptr_t)a + c->Offset;
    int32 res = c->BitMask ? FlipByte(addr, c->BitMask, &o, &n) : -1;
    if (res < 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "SYMBOL: cannot flip %s+%u", sym, (unsigned)c->Offset); return false; }
    CopyName(FI.Hk.LastApp, app, sizeof FI.Hk.LastApp); FI.Hk.LastRegion = 0xFF;
    ReportHit(res, "SYMBOL", app, sym, (unsigned long)c->Offset, addr, o, n, c->BitMask);
    return true;
}

static bool SetEcc(const FAULT_INJ_SetEccCmd_t *c)
{
    FI.Hk.EccEnabled = c->Enabled ? 1 : 0;
    CFE_EVS_SendEvent(EID_ECC_MODE, CFE_EVS_EventType_INFORMATION, "ECC %s", FI.Hk.EccEnabled ? "ON: 1-bit hits corrected, multi-bit detected" : "OFF: every hit lands in memory");
    return true;
}

static bool FlipTmr(const FAULT_INJ_FlipTmrCmd_t *c)
{
    char name[20]; uint8 o, n; CopyName(name, c->Region, sizeof name);
    /* TMR_LIB is a cFS library with global symbols; look it up so FAULT_INJ does not depend on it */
    union { void *obj; TMR_Region_t *(*fn)(const char *); } sym;   /* POSIX-blessed dlsym -> function pointer */
    sym.obj = dlsym(RTLD_DEFAULT, "TMR_Find");
    TMR_Region_t *(*find)(const char *) = sym.fn;
    TMR_Region_t *r = find ? find(name) : NULL;
    if (r == NULL || c->Copy >= TMR_COPIES || c->BitMask == 0)
    {
        CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "TMR: region %s copy %u not found (TMR_LIB %s)", name, c->Copy + 1, find ? "loaded" : "missing");
        return false;
    }
    uint32 off = c->Offset % r->Size;
    uintptr_t addr = (uintptr_t)r->Copy[c->Copy] + off;
    int32 res = FlipByte(addr, c->BitMask, &o, &n);
    if (res < 0) { CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "TMR: cannot write %lx", (unsigned long)addr); return false; }
    char where[16]; snprintf(where, sizeof where, "copy %u", c->Copy + 1);
    snprintf(FI.Hk.LastApp, sizeof FI.Hk.LastApp, "TMR %s", name); FI.Hk.LastRegion = 0xFE;
    ReportHit(res, "TMR", name, where, (unsigned long)off, addr, o, n, c->BitMask);
    return true;
}

static void ProcessCommand(const CFE_SB_Buffer_t *buf)
{
    CFE_MSG_FcnCode_t fc = 0; CFE_MSG_Size_t len = 0; bool ok = false; size_t want = 0;
    CFE_MSG_GetFcnCode(&buf->Msg, &fc);
    CFE_MSG_GetSize(&buf->Msg, &len);
    switch (fc) {
        case FAULT_INJ_NOOP_CC:        want = sizeof(FAULT_INJ_NoArgsCmd_t); break;
        case FAULT_INJ_RESET_CC:       want = sizeof(FAULT_INJ_NoArgsCmd_t); break;
        case FAULT_INJ_QUERY_CC:       want = sizeof(FAULT_INJ_QueryCmd_t); break;
        case FAULT_INJ_FLIP_CC:        want = sizeof(FAULT_INJ_FlipCmd_t); break;
        case FAULT_INJ_FLIP_RANDOM_CC: want = sizeof(FAULT_INJ_FlipRandomCmd_t); break;
        case FAULT_INJ_FLIP_SYMBOL_CC: want = sizeof(FAULT_INJ_FlipSymbolCmd_t); break;
        case FAULT_INJ_SET_ECC_CC:     want = sizeof(FAULT_INJ_SetEccCmd_t); break;
        case FAULT_INJ_FLIP_TMR_CC:    want = sizeof(FAULT_INJ_FlipTmrCmd_t); break;
        default:
            CFE_EVS_SendEvent(EID_CMD_ERR, CFE_EVS_EventType_ERROR, "unknown function code %u", fc);
            FI.Hk.ErrCounter++; SendHk(); return;
    }
    if (len != want) {
        CFE_EVS_SendEvent(EID_CMD_ERR, CFE_EVS_EventType_ERROR, "fc %u: length %lu, expected %lu", fc, (unsigned long)len, (unsigned long)want);
        FI.Hk.ErrCounter++; SendHk(); return;
    }
    switch (fc) {
        case FAULT_INJ_NOOP_CC:
            CFE_EVS_SendEvent(EID_NOOP, CFE_EVS_EventType_INFORMATION, "No-op: FAULT_INJ ready"); ok = true; break;
        case FAULT_INJ_RESET_CC:
            { uint8 ecc = FI.Hk.EccEnabled;
              memset(&FI.Hk.CmdCounter, 0, sizeof(FI.Hk) - offsetof(FAULT_INJ_HkTlm_t, CmdCounter));
              FI.Hk.EccEnabled = ecc; }
            CFE_EVS_SendEvent(EID_RESET, CFE_EVS_EventType_INFORMATION, "counters reset"); SendHk(); return;
        case FAULT_INJ_QUERY_CC:       ok = Query((const void *)buf); break;
        case FAULT_INJ_FLIP_CC:        ok = Flip((const void *)buf); break;
        case FAULT_INJ_FLIP_RANDOM_CC: ok = FlipRandom((const void *)buf); break;
        case FAULT_INJ_FLIP_SYMBOL_CC: ok = FlipSymbol((const void *)buf); break;
        case FAULT_INJ_SET_ECC_CC:     ok = SetEcc((const void *)buf); break;
        case FAULT_INJ_FLIP_TMR_CC:    ok = FlipTmr((const void *)buf); break;
    }
    if (ok) FI.Hk.CmdCounter++; else FI.Hk.ErrCounter++;
    SendHk();
}

void FAULT_INJ_AppMain(void)
{
    uint32 RunStatus = CFE_ES_RunStatus_APP_RUN;
    CFE_SB_Buffer_t *buf;

    memset(&FI, 0, sizeof FI);
    CFE_EVS_Register(NULL, 0, CFE_EVS_EventFilter_BINARY);
    CFE_MSG_Init(CFE_MSG_PTR(FI.Hk.Hdr), CFE_SB_ValueToMsgId(FAULT_INJ_HK_MID), sizeof(FI.Hk));
    if (CFE_SB_CreatePipe(&FI.Pipe, 16, "FAULT_INJ_PIPE") != CFE_SUCCESS ||
        CFE_SB_Subscribe(CFE_SB_ValueToMsgId(FAULT_INJ_CMD_MID), FI.Pipe) != CFE_SUCCESS) {
        CFE_ES_WriteToSysLog("FAULT_INJ: pipe setup failed\n");
        RunStatus = CFE_ES_RunStatus_APP_ERROR;
    } else {
        CFE_EVS_SendEvent(EID_INIT, CFE_EVS_EventType_INFORMATION, "FAULT_INJ initialized (cmd 0x%04X, hk 0x%04X)", FAULT_INJ_CMD_MID, FAULT_INJ_HK_MID);
    }

    while (CFE_ES_RunLoop(&RunStatus)) {
        int32 st = CFE_SB_ReceiveBuffer(&buf, FI.Pipe, 1000);
        if (st == CFE_SUCCESS) {
            CFE_SB_MsgId_t mid = CFE_SB_INVALID_MSG_ID;
            CFE_MSG_GetMsgId(&buf->Msg, &mid);
            if (CFE_SB_MsgIdToValue(mid) == FAULT_INJ_CMD_MID) ProcessCommand(buf);
        } else if (st == CFE_SB_TIME_OUT) {
            SendHk();
        } else {
            RunStatus = CFE_ES_RunStatus_APP_ERROR;
        }
    }
    CFE_ES_ExitApp(RunStatus);
}
