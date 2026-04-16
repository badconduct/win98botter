/*
 * file_ops.h
 */

#ifndef FILE_OPS_H
#define FILE_OPS_H

#include "cJSON.h"

cJSON *tool_read_file(cJSON *params);
cJSON *tool_write_file(cJSON *params);
cJSON *tool_write_file_binary(cJSON *params);
cJSON *tool_append_file(cJSON *params);
cJSON *tool_delete_file(cJSON *params);
cJSON *tool_copy_file(cJSON *params);
cJSON *tool_move_file(cJSON *params);
cJSON *tool_get_file_info(cJSON *params);
cJSON *tool_list_directory(cJSON *params);
cJSON *tool_grep_file(cJSON *params);
cJSON *tool_get_history(cJSON *params);
cJSON *tool_file_exists(cJSON *params);

#endif /* FILE_OPS_H */
