/*
 * ini_ops.h
 */

#ifndef INI_OPS_H
#define INI_OPS_H

#include "cJSON.h"

cJSON *tool_ini_read(cJSON *params);
cJSON *tool_ini_read_section(cJSON *params);
cJSON *tool_ini_list_sections(cJSON *params);
cJSON *tool_ini_write(cJSON *params);
cJSON *tool_ini_delete_key(cJSON *params);

#endif /* INI_OPS_H */
