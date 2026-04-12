/*
 * registry_ops.h
 */

#ifndef REGISTRY_OPS_H
#define REGISTRY_OPS_H

#include "cJSON.h"

cJSON *tool_read_registry(cJSON *params);
cJSON *tool_write_registry(cJSON *params);
cJSON *tool_delete_registry(cJSON *params);
cJSON *tool_list_registry(cJSON *params);

#endif /* REGISTRY_OPS_H */
