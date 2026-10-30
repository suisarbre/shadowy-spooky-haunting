/*
 * TMR_LIB - software triple modular redundancy for cFS
 *
 * A TMR region holds one piece of critical state three times, in three
 * independent memory partitions (separate mappings, each with a guard page,
 * so one upset cannot reach two copies). Callers update every copy, then call
 * TMR_Vote(): each byte takes the bitwise majority of the three copies, and a
 * copy that disagrees is overwritten with the majority, without a reboot.
 *
 * With TMR disabled for a region only copy 0 is used and nothing is voted,
 * which is how ordinary software keeps its state.
 */
#ifndef TMR_LIB_H
#define TMR_LIB_H

#include "common_types.h"

#define TMR_COPIES      3
#define TMR_MAX_REGIONS 8
#define TMR_NAME_LEN    20

typedef struct
{
    char   Name[TMR_NAME_LEN];
    uint8 *Copy[TMR_COPIES];   /* the three partitions */
    uint32 Size;
    bool   Enabled;
    uint32 Votes;              /* vote passes */
    uint32 RepairedBytes;      /* bytes rewritten from the majority */
    uint32 RepairEvents;       /* votes that found and fixed a bad copy */
    uint32 RepairedCopies[TMR_COPIES];
} TMR_Region_t;

/* Create a region of Size bytes, all three copies zeroed. Returns NULL on failure. */
TMR_Region_t *TMR_Alloc(const char *Name, uint32 Size);

/* Vote all copies into Out (may be NULL) and repair any copy that differs.
 * Returns a bitmask of the copies that were repaired (0 = all agreed). */
uint8 TMR_Vote(TMR_Region_t *R, void *Out);

/* Turn TMR on or off. Turning it on re-seeds copies 1 and 2 from copy 0. */
void TMR_SetEnabled(TMR_Region_t *R, bool Enabled);

/* Find a region by name, for fault injection and diagnostics. */
TMR_Region_t *TMR_Find(const char *Name);

/* Library entry point, called by cFE ES at startup. */
int32 TMR_LIB_Init(void);

#endif
