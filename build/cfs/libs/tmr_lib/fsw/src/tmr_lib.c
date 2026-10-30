#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include "cfe.h"
#include "tmr_lib.h"

static TMR_Region_t TMR_Regions[TMR_MAX_REGIONS];
static uint32       TMR_RegionCount;

int32 TMR_LIB_Init(void)
{
    memset(TMR_Regions, 0, sizeof(TMR_Regions));
    TMR_RegionCount = 0;
    OS_printf("TMR_LIB initialized: %d copies per region, up to %d regions\n", TMR_COPIES, TMR_MAX_REGIONS);
    return CFE_SUCCESS;
}

/* One partition: its own anonymous mapping, followed by an inaccessible guard page. */
static uint8 *TMR_MapPartition(uint32 Size)
{
    long   pg  = sysconf(_SC_PAGESIZE);
    size_t len = ((Size + pg - 1) / pg) * pg;
    uint8 *p   = mmap(NULL, len + pg, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) return NULL;
    mprotect(p + len, pg, PROT_NONE);
    return p;
}

TMR_Region_t *TMR_Alloc(const char *Name, uint32 Size)
{
    if (TMR_RegionCount >= TMR_MAX_REGIONS || Size == 0) return NULL;
    TMR_Region_t *R = &TMR_Regions[TMR_RegionCount];
    memset(R, 0, sizeof(*R));
    strncpy(R->Name, Name, TMR_NAME_LEN - 1);
    R->Size    = Size;
    R->Enabled = true;
    for (int i = 0; i < TMR_COPIES; i++)
    {
        R->Copy[i] = TMR_MapPartition(Size);
        if (R->Copy[i] == NULL) return NULL;
    }
    TMR_RegionCount++;
    /* publish where each copy lives, so diagnostics can show the partitions on a memory map */
    FILE *f = fopen("/tmp/tmr_regions", "a");
    if (f != NULL)
    {
        for (int i = 0; i < TMR_COPIES; i++) fprintf(f, "%s %d %lx %lx\n", R->Name, i, (unsigned long)R->Copy[i], (unsigned long)Size);
        fclose(f);
    }
    return R;
}

uint8 TMR_Vote(TMR_Region_t *R, void *Out)
{
    uint8 *o = Out, repaired = 0;
    if (!R->Enabled)
    {
        if (o) memcpy(o, R->Copy[0], R->Size);
        return 0;
    }
    R->Votes++;
    for (uint32 i = 0; i < R->Size; i++)
    {
        uint8 a = R->Copy[0][i], b = R->Copy[1][i], c = R->Copy[2][i];
        uint8 m = (a & b) | (a & c) | (b & c);   /* bitwise majority */
        if (a != m) { R->Copy[0][i] = m; repaired |= 1; R->RepairedBytes++; }
        if (b != m) { R->Copy[1][i] = m; repaired |= 2; R->RepairedBytes++; }
        if (c != m) { R->Copy[2][i] = m; repaired |= 4; R->RepairedBytes++; }
        if (o) o[i] = m;
    }
    if (repaired)
    {
        R->RepairEvents++;
        for (int k = 0; k < TMR_COPIES; k++)
            if (repaired & (1 << k)) R->RepairedCopies[k]++;
    }
    return repaired;
}

void TMR_SetEnabled(TMR_Region_t *R, bool Enabled)
{
    if (Enabled && !R->Enabled)
    {
        /* copies 1 and 2 went stale while TMR was off: start them from copy 0 */
        memcpy(R->Copy[1], R->Copy[0], R->Size);
        memcpy(R->Copy[2], R->Copy[0], R->Size);
    }
    R->Enabled = Enabled;
}

TMR_Region_t *TMR_Find(const char *Name)
{
    for (uint32 i = 0; i < TMR_RegionCount; i++)
        if (strncmp(TMR_Regions[i].Name, Name, TMR_NAME_LEN) == 0) return &TMR_Regions[i];
    return NULL;
}
