/*
 * exec_ops.h
 */

#ifndef EXEC_OPS_H
#define EXEC_OPS_H

#include "cJSON.h"

cJSON *tool_run_command(cJSON *params);
cJSON *tool_run_bat(cJSON *params);
cJSON *tool_write_and_run_bat(cJSON *params);

cJSON *tool_start_command(cJSON *params);
cJSON *tool_get_command_status(cJSON *params);
cJSON *tool_get_command_output(cJSON *params);
cJSON *tool_stop_command(cJSON *params);

cJSON *tool_schedule_task(cJSON *params);
cJSON *tool_list_tasks(cJSON *params);
cJSON *tool_delete_task(cJSON *params);

#endif /* EXEC_OPS_H */
