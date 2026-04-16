/*
 * process_ops.h
 */

#ifndef PROCESS_OPS_H
#define PROCESS_OPS_H

#include "cJSON.h"

cJSON *tool_list_processes(cJSON *params);
cJSON *tool_kill_process(cJSON *params);

#endif /* PROCESS_OPS_H */
