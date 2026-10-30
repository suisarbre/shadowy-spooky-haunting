/************************************************************************
 * NASA Docket No. GSC-19,200-1, and identified as "cFS Draco"
 *
 * Copyright (c) 2023 United States Government as represented by the
 * Administrator of the National Aeronautics and Space Administration.
 * All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may obtain
 * a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 ************************************************************************/

/************************************************************************************************
** File:  cfe_psp_watchdog.c
**
** Purpose:
**   This file contains glue routines between the cFE and the OS Board Support Package ( BSP ).
**   The functions here allow the cFE to interface functions that are board and OS specific
**   and usually don't fit well in the OS abstraction layer.
**
** History:
**   2009/07/20  A. Cudmore    | Initial version,
**
*************************************************************************************************/

/*
**  Include Files
*/

/*
** cFE includes
*/
#include "common_types.h"
#include "osapi.h"

/*
**  System Include Files
*/
#include <stdio.h>
#include <stdlib.h>

/*
** Types and prototypes for this module
*/
#include "cfe_psp.h"
#include "cfe_psp_config.h"

/*
** Global data
*/

/*
** The watchdog time in milliseconds
*/
uint32 CFE_PSP_WatchdogValue = CFE_PSP_WATCHDOG_MAX;

/*
 * SpaceY v86 build: the hardware watchdog is a separate (simulated) chip on an
 * onboard serial bus, /dev/ttyS2. Each call sends one line to it:
 *   "WE" enable, "WD" disable, "WS<ms>" set timeout, "WK" kick (service)
 * If the bus is not present the calls do nothing, like the stock pc-linux PSP.
 */
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <termios.h>

static int CFE_PSP_WatchdogFd = -2; /* -2 = not opened yet, -1 = unavailable */

static void CFE_PSP_WatchdogSend(const char *line)
{
    if (CFE_PSP_WatchdogFd == -2)
    {
        CFE_PSP_WatchdogFd = open("/dev/ttyS2", O_WRONLY | O_NOCTTY | O_NONBLOCK);
        if (CFE_PSP_WatchdogFd >= 0)
        {
            struct termios t;
            if (tcgetattr(CFE_PSP_WatchdogFd, &t) == 0)
            {
                cfmakeraw(&t);
                tcsetattr(CFE_PSP_WatchdogFd, TCSANOW, &t);
            }
        }
    }
    if (CFE_PSP_WatchdogFd >= 0)
    {
        if (write(CFE_PSP_WatchdogFd, line, strlen(line)) < 0)
        {
            /* bus busy or gone: the chip simply misses this line */
        }
    }
}

void CFE_PSP_WatchdogInit(void)
{
    CFE_PSP_WatchdogValue = CFE_PSP_WATCHDOG_MAX;
}

void CFE_PSP_WatchdogEnable(void)
{
    CFE_PSP_WatchdogSend("WE\n");
}

void CFE_PSP_WatchdogDisable(void)
{
    CFE_PSP_WatchdogSend("WD\n");
}

void CFE_PSP_WatchdogService(void)
{
    CFE_PSP_WatchdogSend("WK\n");
}

uint32 CFE_PSP_WatchdogGet(void)
{
    return CFE_PSP_WatchdogValue;
}

void CFE_PSP_WatchdogSet(uint32 WatchdogValue)
{
    char line[24];
    CFE_PSP_WatchdogValue = WatchdogValue;
    snprintf(line, sizeof(line), "WS%lu\n", (unsigned long)WatchdogValue);
    CFE_PSP_WatchdogSend(line);
}
