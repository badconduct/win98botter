/*
 * system_ops.h
 */

#ifndef SYSTEM_OPS_H
#define SYSTEM_OPS_H

#include "cJSON.h"

cJSON *tool_get_system_info(cJSON *params);
cJSON *tool_get_disk_info(cJSON *params);
cJSON *tool_get_screen_resolution(cJSON *params);
cJSON *tool_set_display_settings(cJSON *params);
cJSON *tool_set_desktop_appearance(cJSON *params);
cJSON *tool_read_port(cJSON *params);
cJSON *tool_write_port(cJSON *params);
cJSON *tool_load_vxd(cJSON *params);
cJSON *tool_get_window_list(cJSON *params);
cJSON *tool_send_window_message(cJSON *params);
cJSON *tool_read_clipboard(cJSON *params);
cJSON *tool_get_comm_port_state(cJSON *params);
cJSON *tool_read_serial(cJSON *params);
cJSON *tool_write_serial(cJSON *params);
cJSON *tool_get_audio_devices(cJSON *params);
cJSON *tool_get_midi_devices(cJSON *params);

#endif /* SYSTEM_OPS_H */
