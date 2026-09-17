/*
 * network_ops.h - structured, read-only IPv4 diagnostics for Win98.
 */

#ifndef NETWORK_OPS_H
#define NETWORK_OPS_H

#include "cJSON.h"

cJSON *tool_get_network_config(cJSON *params);
cJSON *tool_ping_host(cJSON *params);
cJSON *tool_dns_lookup(cJSON *params);
cJSON *tool_list_network_connections(cJSON *params);

#endif /* NETWORK_OPS_H */
