/*
 * permissions.c — permissions.ini loader + tool filter
 *
 * Reads C:\WIN98BOTTER\permissions.ini on startup and on each tools/list
 * request (so the relay can update permissions at runtime without restarting
 * the agent).
 *
 * Format expected:
 *   [tools]
 *   read_file=1
 *   write_file=0
 *   ...
 *
 * All permissions default to 0 (off) if the key is missing.
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include "config.h"
#include "permissions.h"

/* ── Static permissions state ─────────────────────────────────────────────── */
static Permissions g_perms;
static int g_perms_loaded = 0;

/* ── Internal helpers ─────────────────────────────────────────────────────── */

static int read_ini_bool(const char *path, const char *section, const char *key)
{
    char buf[8];
    DWORD n;
    n = GetPrivateProfileStringA(section, key, "0", buf, sizeof(buf), path);
    if (n == 0) return 0;
    return (buf[0] == '1') ? 1 : 0;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

void permissions_load(const char *ini_path)
{
    const char *section = "tools";

    if (!ini_path || ini_path[0] == '\0') {
        ini_path = PERMISSIONS_INI;
    }

    g_perms.read_file       = read_ini_bool(ini_path, section, "read_file");
    g_perms.write_file      = read_ini_bool(ini_path, section, "write_file");
    g_perms.delete_file     = read_ini_bool(ini_path, section, "delete_file");
    g_perms.list_processes  = read_ini_bool(ini_path, section, "list_processes");
    g_perms.kill_process    = read_ini_bool(ini_path, section, "kill_process");
    g_perms.run_command     = read_ini_bool(ini_path, section, "run_command");
    g_perms.read_registry   = read_ini_bool(ini_path, section, "read_registry");
    g_perms.write_registry  = read_ini_bool(ini_path, section, "write_registry");
    g_perms.read_port       = read_ini_bool(ini_path, section, "read_port");
    g_perms.write_port      = read_ini_bool(ini_path, section, "write_port");
    g_perms.load_vxd        = read_ini_bool(ini_path, section, "load_vxd");
    g_perms.modify_sysconfig= read_ini_bool(ini_path, section, "modify_sysconfig");
    g_perms.serial          = read_ini_bool(ini_path, section, "serial");
    g_perms.scheduler       = read_ini_bool(ini_path, section, "scheduler");
    g_perms.audio           = read_ini_bool(ini_path, section, "audio");
    g_perms.display         = read_ini_bool(ini_path, section, "display");
    g_perms.screenshot      = read_ini_bool(ini_path, section, "screenshot");

    g_perms_loaded = 1;
}

const Permissions *permissions_get(void)
{
    if (!g_perms_loaded) {
        permissions_load(NULL);
    }
    return &g_perms;
}

int permission_allowed(const char *tool_name)
{
    const Permissions *p = permissions_get();

    /* File read tools */
    if (strcmp(tool_name, "read_file")         == 0 ||
        strcmp(tool_name, "grep_file")          == 0 ||
        strcmp(tool_name, "get_file_info")      == 0 ||
        strcmp(tool_name, "file_exists")        == 0 ||
        strcmp(tool_name, "list_directory")     == 0 ||
        strcmp(tool_name, "list_backups")       == 0 ||
        strcmp(tool_name, "get_history")        == 0 ||
        strcmp(tool_name, "ini_read")           == 0 ||
        strcmp(tool_name, "ini_read_section")   == 0 ||
        strcmp(tool_name, "ini_list_sections")  == 0) {
        return p->read_file;
    }

    /* File write tools */
    if (strcmp(tool_name, "write_file")        == 0 ||
        strcmp(tool_name, "write_file_binary") == 0 ||
        strcmp(tool_name, "append_file")       == 0 ||
        strcmp(tool_name, "copy_file")         == 0 ||
        strcmp(tool_name, "move_file")         == 0 ||
        strcmp(tool_name, "restore_backup")    == 0 ||
        strcmp(tool_name, "ini_write")         == 0 ||
        strcmp(tool_name, "ini_delete_key")    == 0) {
        return p->write_file;
    }

    /* Delete file */
    if (strcmp(tool_name, "delete_file") == 0) {
        return p->delete_file;
    }

    /* Process list */
    if (strcmp(tool_name, "list_processes") == 0) {
        return p->list_processes;
    }

    /* Process kill */
    if (strcmp(tool_name, "kill_process") == 0) {
        return p->kill_process;
    }

    /* Command execution */
    if (strcmp(tool_name, "run_command")       == 0 ||
        strcmp(tool_name, "run_bat")           == 0 ||
        strcmp(tool_name, "write_and_run_bat") == 0 ||
        strcmp(tool_name, "start_command")     == 0 ||
        strcmp(tool_name, "get_command_status")== 0 ||
        strcmp(tool_name, "get_command_output")== 0 ||
        strcmp(tool_name, "stop_command")      == 0) {
        return p->run_command;
    }

    /* Registry read */
    if (strcmp(tool_name, "read_registry")  == 0 ||
        strcmp(tool_name, "list_registry")  == 0) {
        return p->read_registry;
    }

    /* Registry write */
    if (strcmp(tool_name, "write_registry") == 0 ||
        strcmp(tool_name, "delete_registry")== 0) {
        return p->write_registry;
    }

    /* Hardware port I/O */
    if (strcmp(tool_name, "read_port")  == 0) return p->read_port;
    if (strcmp(tool_name, "write_port") == 0) return p->write_port;
    if (strcmp(tool_name, "load_vxd")   == 0) return p->load_vxd;

    /* Serial / COM */
    if (strcmp(tool_name, "get_comm_port_state") == 0 ||
        strcmp(tool_name, "read_serial")         == 0 ||
        strcmp(tool_name, "write_serial")        == 0) {
        return p->serial;
    }

    /* Scheduler */
    if (strcmp(tool_name, "schedule_task")      == 0 ||
        strcmp(tool_name, "list_tasks")         == 0 ||
        strcmp(tool_name, "delete_task")        == 0) {
        return p->scheduler;
    }

    /* Audio / MIDI */
    if (strcmp(tool_name, "get_audio_devices")  == 0 ||
        strcmp(tool_name, "get_midi_devices")   == 0) {
        return p->audio;
    }

    /* Display */
    if (strcmp(tool_name, "set_display_settings")   == 0 ||
        strcmp(tool_name, "set_desktop_appearance")  == 0) {
        return p->display;
    }

    /* Screenshot capture */
    if (strcmp(tool_name, "capture_screenshot") == 0) {
        return p->screenshot;
    }

    /* Always-allowed read-only system tools */
    if (strcmp(tool_name, "get_system_info")   == 0 ||
        strcmp(tool_name, "get_disk_info")     == 0 ||
        strcmp(tool_name, "get_window_list")   == 0 ||
        strcmp(tool_name, "read_clipboard")    == 0 ||
        strcmp(tool_name, "send_window_message") == 0 ||
        strcmp(tool_name, "get_screen_resolution") == 0) {
        return 1;
    }

    /* Unknown tool — deny by default */
    return 0;
}

/*
 * Update in-memory permissions from a JSON object sent by the relay.
 * Keys match the field names in permissions.ini.  Unrecognised keys are
 * silently ignored.  Does NOT write back to disk — use permissions_load()
 * to persist across restarts.
 */
void permissions_set_from_json(cJSON *obj)
{
    cJSON *item;
    int   val;

    if (!obj) return;

    /* Ensure struct is initialised before we patch it */
    if (!g_perms_loaded) permissions_load(NULL);

#define SET_PERM(field, key) \
    item = cJSON_GetObjectItemCaseSensitive(obj, key); \
    if (item) { \
        val = cJSON_IsTrue(item) ? 1 : (cJSON_IsNumber(item) ? (item->valueint != 0) : 0); \
        g_perms.field = val; \
    }

    SET_PERM(read_file,        "read_file")
    SET_PERM(write_file,       "write_file")
    SET_PERM(delete_file,      "delete_file")
    SET_PERM(list_processes,   "list_processes")
    SET_PERM(kill_process,     "kill_process")
    SET_PERM(run_command,      "run_command")
    SET_PERM(read_registry,    "read_registry")
    SET_PERM(write_registry,   "write_registry")
    SET_PERM(read_port,        "read_port")
    SET_PERM(write_port,       "write_port")
    SET_PERM(load_vxd,         "load_vxd")
    SET_PERM(modify_sysconfig, "modify_sysconfig")
    SET_PERM(serial,           "serial")
    SET_PERM(scheduler,        "scheduler")
    SET_PERM(audio,            "audio")
    SET_PERM(display,          "display")
    SET_PERM(screenshot,       "screenshot")

#undef SET_PERM
}

/* Build the "permissions" JSON object for the initialize response.         */
/* Caller must free the returned cJSON node.                                 */
#include "cJSON.h"

cJSON *permissions_to_json(void)
{
    const Permissions *p = permissions_get();
    cJSON *obj = cJSON_CreateObject();

    cJSON_AddBoolToObject(obj, "read_file",        p->read_file);
    cJSON_AddBoolToObject(obj, "write_file",       p->write_file);
    cJSON_AddBoolToObject(obj, "delete_file",      p->delete_file);
    cJSON_AddBoolToObject(obj, "list_processes",   p->list_processes);
    cJSON_AddBoolToObject(obj, "kill_process",     p->kill_process);
    cJSON_AddBoolToObject(obj, "run_command",      p->run_command);
    cJSON_AddBoolToObject(obj, "read_registry",    p->read_registry);
    cJSON_AddBoolToObject(obj, "write_registry",   p->write_registry);
    cJSON_AddBoolToObject(obj, "read_port",        p->read_port);
    cJSON_AddBoolToObject(obj, "write_port",       p->write_port);
    cJSON_AddBoolToObject(obj, "load_vxd",         p->load_vxd);
    cJSON_AddBoolToObject(obj, "modify_sysconfig", p->modify_sysconfig);
    cJSON_AddBoolToObject(obj, "serial",           p->serial);
    cJSON_AddBoolToObject(obj, "scheduler",        p->scheduler);
    cJSON_AddBoolToObject(obj, "audio",            p->audio);
    cJSON_AddBoolToObject(obj, "display",          p->display);
    cJSON_AddBoolToObject(obj, "screenshot",       p->screenshot);

    return obj;
}
