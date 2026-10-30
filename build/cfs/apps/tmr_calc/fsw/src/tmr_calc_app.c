/*
 * TMR_CALC - a calculator whose answer the ground can check.
 *
 * Every second: Step += 1, Sum += Step, so Sum must equal Step*(Step+1)/2.
 * Because the sum accumulates, one corrupted value stays wrong forever, which
 * makes the effect of a bit flip easy to see.
 *
 * The state lives in a TMR region ("CALC"): each of the three copies does its
 * own calculation from its own state, then TMR_Vote() takes the majority and
 * repairs a copy that differs, without a reboot. With TMR off only copy 0
 * exists in practice and nothing repairs it.
 *
 * Commands (MID 0x18C1): 0 NOOP, 1 RESET, 2 SET_TMR (u8 enabled)
 * Telemetry (MID 0x08C1): once a second, after each calculation
 */
#include <string.h>
#include "cfe.h"
#include "tmr_lib.h"

#define TMR_CALC_CMD_MID 0x18C1
#define TMR_CALC_HK_MID  0x08C1

enum { EID_INIT = 1, EID_NOOP, EID_RESET, EID_MODE, EID_REPAIR, EID_ERR };

typedef struct { uint32 Step; uint32 Sum; } CalcState_t;

typedef struct {
    CFE_MSG_TelemetryHeader_t Hdr;
    uint32 Step;                    /* voted */
    uint32 Sum;                     /* voted */
    uint32 CopySum[TMR_COPIES];     /* each copy's result before the vote */
    uint32 CopyStep[TMR_COPIES];
    uint32 RepairEvents;
    uint32 RepairedCopies[TMR_COPIES];
    uint8  Enabled;
    uint8  LastRepairMask;          /* copies repaired in this calculation */
    uint16 Spare;
} TMR_CALC_HkTlm_t;

typedef struct { CFE_MSG_CommandHeader_t Hdr; } TMR_CALC_NoArgsCmd_t;
typedef struct { CFE_MSG_CommandHeader_t Hdr; uint8 Enabled; uint8 Spare[3]; } TMR_CALC_SetTmrCmd_t;

static struct {
    CFE_SB_PipeId_t  Pipe;
    TMR_Region_t    *Region;
    TMR_CALC_HkTlm_t Hk;
} TC;

static void Calculate(void)
{
    CalcState_t voted;
    int copies = TC.Region->Enabled ? TMR_COPIES : 1;
    /* each partition computes from its own state */
    for (int k = 0; k < copies; k++)
    {
        CalcState_t *s = (CalcState_t *)TC.Region->Copy[k];
        s->Step += 1;
        s->Sum  += s->Step;
    }
    for (int k = 0; k < TMR_COPIES; k++)
    {
        const CalcState_t *s = (const CalcState_t *)TC.Region->Copy[k];
        TC.Hk.CopySum[k] = s->Sum; TC.Hk.CopyStep[k] = s->Step;
    }
    uint8 rep = TMR_Vote(TC.Region, &voted);
    TC.Hk.LastRepairMask = rep;
    if (rep)
    {
        for (int k = 0; k < TMR_COPIES; k++)
            if (rep & (1 << k))
                CFE_EVS_SendEvent(EID_REPAIR, CFE_EVS_EventType_INFORMATION,
                                  "TMR outvoted copy %d (step %lu sum %lu); repaired to step %lu sum %lu",
                                  k + 1, (unsigned long)TC.Hk.CopyStep[k], (unsigned long)TC.Hk.CopySum[k],
                                  (unsigned long)voted.Step, (unsigned long)voted.Sum);
    }
    TC.Hk.Step = voted.Step; TC.Hk.Sum = voted.Sum;
    TC.Hk.RepairEvents = TC.Region->RepairEvents;
    for (int k = 0; k < TMR_COPIES; k++) TC.Hk.RepairedCopies[k] = TC.Region->RepairedCopies[k];
    TC.Hk.Enabled = TC.Region->Enabled;
    CFE_SB_TimeStampMsg(CFE_MSG_PTR(TC.Hk.Hdr));
    CFE_SB_TransmitMsg(CFE_MSG_PTR(TC.Hk.Hdr), true);
}

static void ProcessCommand(const CFE_SB_Buffer_t *buf)
{
    CFE_MSG_FcnCode_t fc = 0; CFE_MSG_Size_t len = 0;
    CFE_MSG_GetFcnCode(&buf->Msg, &fc); CFE_MSG_GetSize(&buf->Msg, &len);
    switch (fc)
    {
        case 0:
            if (len != sizeof(TMR_CALC_NoArgsCmd_t)) break;
            CFE_EVS_SendEvent(EID_NOOP, CFE_EVS_EventType_INFORMATION, "No-op: TMR_CALC step %lu sum %lu, TMR %s",
                              (unsigned long)TC.Hk.Step, (unsigned long)TC.Hk.Sum, TC.Region->Enabled ? "on" : "off");
            return;
        case 1:
            if (len != sizeof(TMR_CALC_NoArgsCmd_t)) break;
            for (int k = 0; k < TMR_COPIES; k++) memset(TC.Region->Copy[k], 0, TC.Region->Size);
            TC.Region->RepairEvents = 0; memset(TC.Region->RepairedCopies, 0, sizeof(TC.Region->RepairedCopies));
            CFE_EVS_SendEvent(EID_RESET, CFE_EVS_EventType_INFORMATION, "calculator reset to step 0");
            return;
        case 2:
            if (len != sizeof(TMR_CALC_SetTmrCmd_t)) break;
            TMR_SetEnabled(TC.Region, ((const TMR_CALC_SetTmrCmd_t *)buf)->Enabled != 0);
            CFE_EVS_SendEvent(EID_MODE, CFE_EVS_EventType_INFORMATION, "software TMR %s",
                              TC.Region->Enabled ? "ON: 3 partitions computed and voted" : "OFF: one copy, no voting");
            return;
        default: break;
    }
    CFE_EVS_SendEvent(EID_ERR, CFE_EVS_EventType_ERROR, "bad command: fc %u length %lu", fc, (unsigned long)len);
}

void TMR_CALC_AppMain(void)
{
    uint32 RunStatus = CFE_ES_RunStatus_APP_RUN;
    CFE_SB_Buffer_t *buf;
    OS_time_t next;

    memset(&TC, 0, sizeof(TC));
    CFE_EVS_Register(NULL, 0, CFE_EVS_EventFilter_BINARY);
    CFE_MSG_Init(CFE_MSG_PTR(TC.Hk.Hdr), CFE_SB_ValueToMsgId(TMR_CALC_HK_MID), sizeof(TC.Hk));
    TC.Region = TMR_Find("CALC");
    if (TC.Region == NULL) TC.Region = TMR_Alloc("CALC", sizeof(CalcState_t));
    if (TC.Region == NULL ||
        CFE_SB_CreatePipe(&TC.Pipe, 8, "TMR_CALC_PIPE") != CFE_SUCCESS ||
        CFE_SB_Subscribe(CFE_SB_ValueToMsgId(TMR_CALC_CMD_MID), TC.Pipe) != CFE_SUCCESS)
    {
        CFE_ES_WriteToSysLog("TMR_CALC: setup failed\n");
        RunStatus = CFE_ES_RunStatus_APP_ERROR;
    }
    else
    {
        CFE_EVS_SendEvent(EID_INIT, CFE_EVS_EventType_INFORMATION, "TMR_CALC initialized: state in 3 partitions, TMR on");
    }

    OS_GetLocalTime(&next);
    while (CFE_ES_RunLoop(&RunStatus))
    {
        /* wait for commands until the next 1 s tick */
        OS_time_t now; OS_GetLocalTime(&now);
        int64 ms = OS_TimeGetTotalMilliseconds(OS_TimeSubtract(next, now));
        int32 st = CFE_SB_ReceiveBuffer(&buf, TC.Pipe, ms > 0 ? (int32)ms : CFE_SB_POLL);
        if (st == CFE_SUCCESS)
        {
            CFE_SB_MsgId_t mid = CFE_SB_INVALID_MSG_ID;
            CFE_MSG_GetMsgId(&buf->Msg, &mid);
            if (CFE_SB_MsgIdToValue(mid) == TMR_CALC_CMD_MID) ProcessCommand(buf);
            continue;
        }
        if (st != CFE_SB_TIME_OUT && st != CFE_SB_NO_MESSAGE) { RunStatus = CFE_ES_RunStatus_APP_ERROR; break; }
        Calculate();
        next = OS_TimeAdd(next, OS_TimeAssembleFromMilliseconds(1, 0));
    }
    CFE_ES_ExitApp(RunStatus);
}
