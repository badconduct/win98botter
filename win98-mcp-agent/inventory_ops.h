/*
 * inventory_ops.h - structured software, startup, and device inventory.
 */

#ifndef INVENTORY_OPS_H
#define INVENTORY_OPS_H

#include "cJSON.h"

cJSON *tool_list_installed_apps(cJSON *params);
cJSON *tool_list_startup_items(cJSON *params);
cJSON *tool_list_devices(cJSON *params);

#endif /* INVENTORY_OPS_H */
