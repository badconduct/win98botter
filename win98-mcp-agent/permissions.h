/*
 * permissions.h — exported types and prototypes for permissions.c
 */

#ifndef PERMISSIONS_H
#define PERMISSIONS_H

#include "cJSON.h"

/* Flat struct — one int per permission category */
typedef struct {
    int read_file;
    int write_file;
    int delete_file;
    int list_processes;
    int kill_process;
    int run_command;
    int read_registry;
    int write_registry;
    int read_port;
    int write_port;
    int load_vxd;
    int modify_sysconfig;
    int serial;
    int scheduler;
    int audio;
    int display;
} Permissions;

void             permissions_load(const char *ini_path);
void             permissions_set_from_json(cJSON *obj);  /* relay runtime override */
const Permissions *permissions_get(void);
int              permission_allowed(const char *tool_name);
cJSON           *permissions_to_json(void);

#endif /* PERMISSIONS_H */
