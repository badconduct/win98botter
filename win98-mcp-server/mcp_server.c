/*
 * mcp_server.c — Main entry point for Win98 MCP agent
 *
 * Connects outbound (TCP) to the relay server.
 * Implements 4-byte big-endian length-prefixed JSON-RPC 2.0 framing.
 * Handles MCP handshake and full tool dispatch.
 *
 * Build: see build.bat
 * Requires: cJSON.c, cJSON.h (download from github.com/DaveGamble/cJSON)
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#define _WIN32_WINNT 0x0400
#include <windows.h>
#include <winsock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdarg.h>

#include "cJSON.h"
#include "config.h"
#include "permissions.h"
#include "file_ops.h"
#include "exec_ops.h"
#include "ini_ops.h"
#include "registry_ops.h"
#include "process_ops.h"
#include "system_ops.h"
#include "ipc_ops.h"
#include "cli_mode.h"

/* ── Forward declarations ─────────────────────────────────────────────────── */

static int  tcp_send_msg(SOCKET sock, cJSON *msg);
static int  tcp_recv_msg(SOCKET sock, char **out_buf, int *out_len);
static void send_result(SOCKET sock, cJSON *id, cJSON *result);
static void send_error(SOCKET sock, cJSON *id, int code, const char *msg);
static void dispatch(SOCKET sock, cJSON *req);
static cJSON *build_server_info(void);
static cJSON *build_tools_list(void);
static void   startup_banner(void);
static SOCKET connect_to_relay(const char *host, int port, int retries);
static void   heartbeat_tick(SOCKET sock);
static void   main_loop(SOCKET sock);
static cJSON *do_startup_check(void);

/* ── Globals ──────────────────────────────────────────────────────────────── */

static DWORD g_last_heartbeat_tick = 0;

/* Relay connection parameters — set from environment or defaults */
static char g_relay_host[128] = "127.0.0.1";
static int  g_relay_port      = 9000;
static int  g_log_enabled     = 1;
static int  g_log_verbose     = 0;
static int  g_log_console     = 1;
static char g_log_path[MAX_PATH_BYTES] = AGENT_LOG;

static int parse_bool_str(const char *value, int default_value)
{
    if (!value || !value[0]) return default_value;
    if (lstrcmpiA(value, "1") == 0) return 1;
    if (lstrcmpiA(value, "yes") == 0) return 1;
    if (lstrcmpiA(value, "true") == 0) return 1;
    if (lstrcmpiA(value, "on") == 0) return 1;
    if (lstrcmpiA(value, "0") == 0) return 0;
    if (lstrcmpiA(value, "no") == 0) return 0;
    if (lstrcmpiA(value, "false") == 0) return 0;
    if (lstrcmpiA(value, "off") == 0) return 0;
    return default_value;
}

static void agent_logf(const char *level, const char *fmt, ...)
{
    char message[1024];
    va_list ap;
    FILE *f;
    SYSTEMTIME st;

    va_start(ap, fmt);
    _vsnprintf(message, sizeof(message) - 1, fmt, ap);
    va_end(ap);
    message[sizeof(message) - 1] = '\0';

    if (g_log_console) {
        printf("[MCP] %s\n", message);
    }

    if (!g_log_enabled) return;

    f = fopen(g_log_path, "a");
    if (!f) return;

    GetLocalTime(&st);
    fprintf(f, "%04d-%02d-%02d %02d:%02d:%02d | %-5s | %s\n",
            st.wYear, st.wMonth, st.wDay,
            st.wHour, st.wMinute, st.wSecond,
            level ? level : "INFO", message);
    fclose(f);
}

static void agent_log_debug(const char *fmt, ...)
{
    char message[1024];
    va_list ap;

    if (!g_log_verbose) return;

    va_start(ap, fmt);
    _vsnprintf(message, sizeof(message) - 1, fmt, ap);
    va_end(ap);
    message[sizeof(message) - 1] = '\0';

    agent_logf("DEBUG", "%s", message);
}

/* ── TCP framing ──────────────────────────────────────────────────────────── */

static int tcp_send_msg(SOCKET sock, cJSON *msg)
{
    char  *json_str;
    DWORD  len;
    unsigned char  hdr[4];
    int    sent;

    json_str = cJSON_PrintUnformatted(msg);
    if (!json_str) return -1;

    len = (DWORD)strlen(json_str);

    /* 4-byte big-endian length prefix */
    hdr[0] = (unsigned char)((len >> 24) & 0xFF);
    hdr[1] = (unsigned char)((len >> 16) & 0xFF);
    hdr[2] = (unsigned char)((len >>  8) & 0xFF);
    hdr[3] = (unsigned char)((len      ) & 0xFF);

    sent = send(sock, (const char *)hdr, 4, 0);
    if (sent != 4) { free(json_str); return -1; }

    sent = send(sock, json_str, (int)len, 0);
    free(json_str);
    return (sent == (int)len) ? 0 : -1;
}

/*
 * Receive one framed message.  Caller must free(*out_buf).
 * Returns 0 on success, -1 on error/disconnect.
 */
static int tcp_recv_msg(SOCKET sock, char **out_buf, int *out_len)
{
    unsigned char hdr[4];
    DWORD  msg_len;
    int    received;
    char  *buf;
    int    total;

    /* Receive 4-byte header */
    total = 0;
    while (total < 4) {
        received = recv(sock, (char *)hdr + total, 4 - total, 0);
        if (received <= 0) return -1;
        total += received;
    }

    msg_len = ((DWORD)hdr[0] << 24) | ((DWORD)hdr[1] << 16)
            | ((DWORD)hdr[2] <<  8) |  (DWORD)hdr[3];

    /* Sanity: reject oversized messages (> 16 MB) */
    if (msg_len == 0 || msg_len > 16 * 1024 * 1024) return -1;

    buf = (char *)malloc(msg_len + 1);
    if (!buf) return -1;

    total = 0;
    while ((DWORD)total < msg_len) {
        received = recv(sock, buf + total, (int)(msg_len - (DWORD)total), 0);
        if (received <= 0) { free(buf); return -1; }
        total += received;
    }
    buf[msg_len] = '\0';

    *out_buf = buf;
    *out_len = (int)msg_len;
    return 0;
}

/* ── JSON-RPC helpers ─────────────────────────────────────────────────────── */

static void send_result(SOCKET sock, cJSON *id, cJSON *result)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    else    cJSON_AddNullToObject(msg, "id");
    cJSON_AddItemToObject(msg, "result", result);
    tcp_send_msg(sock, msg);
    cJSON_Delete(msg);
}

static void send_error(SOCKET sock, cJSON *id, int code, const char *message)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON *err = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    else    cJSON_AddNullToObject(msg, "id");
    cJSON_AddNumberToObject(err, "code",    (double)code);
    cJSON_AddStringToObject(err, "message", message);
    cJSON_AddItemToObject(msg, "error", err);
    tcp_send_msg(sock, msg);
    cJSON_Delete(msg);
}

static void send_notification(SOCKET sock, const char *method, cJSON *params)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    cJSON_AddStringToObject(msg, "method",  method);
    if (params) cJSON_AddItemToObject(msg, "params", params);
    tcp_send_msg(sock, msg);
    cJSON_Delete(msg);
}

/* ── Startup self-check ───────────────────────────────────────────────────── */

static cJSON *do_startup_check(void)
{
    cJSON *result = cJSON_CreateObject();
    OSVERSIONINFOA osi;
    MEMORYSTATUS ms;
    char sys_ini[MAX_PATH_BYTES];
    char tmp[64];
    WSADATA wsa_data;

    /* OS version */
    ZeroMemory(&osi, sizeof(osi));
    osi.dwOSVersionInfoSize = sizeof(OSVERSIONINFOA);
    GetVersionExA(&osi);
    _snprintf(tmp, sizeof(tmp), "%lu.%lu.%lu",
              osi.dwMajorVersion, osi.dwMinorVersion,
              osi.dwBuildNumber & 0xFFFF);
    cJSON_AddStringToObject(result, "os_version", tmp);
    cJSON_AddBoolToObject(result, "os_ok",
        (osi.dwMajorVersion == 4 && osi.dwMinorVersion >= 10) ? 1 : 0);

    /* RAM */
    ms.dwLength = sizeof(MEMORYSTATUS);
    GlobalMemoryStatus(&ms);
    cJSON_AddNumberToObject(result, "total_ram_mb",
        (double)(ms.dwTotalPhys / (1024 * 1024)));

    /* SYSTEM.INI MaxFileCache */
    GetWindowsDirectoryA(sys_ini, sizeof(sys_ini));
    strncat(sys_ini, "\\SYSTEM.INI", sizeof(sys_ini) - strlen(sys_ini) - 1);
    {
        char val[32];
        GetPrivateProfileStringA("vcache", "MaxFileCache", "0",
                                 val, sizeof(val), sys_ini);
        cJSON_AddStringToObject(result, "vcache_max", val);
    }

    /* WinSock */
    {
        int ws_ok = (WSAStartup(MAKEWORD(2, 2), &wsa_data) == 0);
        cJSON_AddBoolToObject(result, "winsock_ok", ws_ok);
        if (ws_ok) {
            cJSON_AddStringToObject(result, "winsock_version",
                                    wsa_data.szDescription);
        }
    }

    /* Backup directory */
    {
        BOOL dir_ok;
        CreateDirectoryA(BASE_DIR,    NULL);
        CreateDirectoryA(BACKUP_DIR,  NULL);
        CreateDirectoryA(TEMP_DIR,    NULL);
        dir_ok = (GetFileAttributesA(BACKUP_DIR) != INVALID_FILE_ATTRIBUTES);
        cJSON_AddBoolToObject(result, "base_dir_ok", dir_ok);
        cJSON_AddStringToObject(result, "base_dir", BASE_DIR);
    }

    /* permissions.ini */
    {
        BOOL perm_ok = (GetFileAttributesA(PERMISSIONS_INI) != INVALID_FILE_ATTRIBUTES);
        cJSON_AddBoolToObject(result, "permissions_ini_exists", perm_ok);
        cJSON_AddStringToObject(result, "permissions_ini", PERMISSIONS_INI);
    }

    return result;
}

/* ── Server info (for initialize response) ────────────────────────────────── */

static cJSON *build_server_info(void)
{
    cJSON *info = cJSON_CreateObject();
    cJSON_AddStringToObject(info, "name",    SERVER_NAME);
    cJSON_AddStringToObject(info, "version", SERVER_VERSION);
    return info;
}

/* ── Tools list ───────────────────────────────────────────────────────────── */

static cJSON *build_tools_list(void)
{
    cJSON *arr = cJSON_CreateArray();

    /* Helper macro: add tool schema entry */
#define TOOL(nm, desc, req_perm) do { \
    if (permission_allowed(nm)) { \
        cJSON *t = cJSON_CreateObject(); \
        cJSON_AddStringToObject(t, "name", nm); \
        cJSON_AddStringToObject(t, "description", desc); \
        cJSON_AddItemToArray(arr, t); \
    } \
} while(0)

    TOOL("read_file",          "Read bytes from a file",                       1);
    TOOL("write_file",         "Write text to a file",                         1);
    TOOL("write_file_binary",  "Write a binary chunk to a file handle",        1);
    TOOL("append_file",        "Append text to a file",                        1);
    TOOL("delete_file",        "Delete a file",                                1);
    TOOL("copy_file",          "Copy a file",                                  1);
    TOOL("move_file",          "Move or rename a file",                        1);
    TOOL("get_file_info",      "Get file metadata",                            1);
    TOOL("list_directory",     "List directory contents",                      1);
    TOOL("grep_file",          "Search file for substring",                    1);
    TOOL("get_history",        "Get recent operation history",                 1);
    TOOL("file_exists",        "Check if file exists",                         1);
    TOOL("run_command",        "Run a command and capture output",             1);
    TOOL("run_bat",            "Run a .bat file and capture output",           1);
    TOOL("write_and_run_bat",  "Write a .bat file and run it",                 1);
    TOOL("start_command",      "Start a command asynchronously",               1);
    TOOL("get_command_status", "Get status of an async command",               1);
    TOOL("get_command_output", "Get current output of an async command",       1);
    TOOL("stop_command",       "Terminate an async command",                   1);
    TOOL("schedule_task",      "Schedule a command using AT.EXE",              1);
    TOOL("list_tasks",         "List scheduled tasks",                         1);
    TOOL("delete_task",        "Delete a scheduled task",                      1);
    TOOL("ini_read",           "Read a value from an INI file",                1);
    TOOL("ini_read_section",   "Read all values in an INI section",            1);
    TOOL("ini_list_sections",  "List all sections in an INI file",             1);
    TOOL("ini_write",          "Write a value to an INI file",                 1);
    TOOL("ini_delete_key",     "Delete a key from an INI file",                1);
    TOOL("read_registry",      "Read a registry value",                        1);
    TOOL("write_registry",     "Write a registry value",                       1);
    TOOL("delete_registry",    "Delete a registry key or value",               1);
    TOOL("list_registry",      "List subkeys and values of a registry key",    1);
    TOOL("list_processes",     "List running processes",                       1);
    TOOL("kill_process",       "Terminate a process by PID or name",           1);
    TOOL("get_system_info",    "Get OS version and memory info",               1);
    TOOL("get_disk_info",      "Get disk space info",                          1);
    TOOL("get_screen_resolution","Get screen width/height/bpp",               1);
    TOOL("set_display_settings","Change screen resolution or colour depth",    1);
    TOOL("set_desktop_appearance","Change desktop wallpaper etc",             1);
    TOOL("read_port",          "Read from an I/O port",                        1);
    TOOL("write_port",         "Write to an I/O port",                         1);
    TOOL("load_vxd",           "Load a VxD driver",                            1);
    TOOL("get_window_list",    "List all visible windows",                     1);
    TOOL("send_window_message","Send a WM_ message to a window",              1);
    TOOL("read_clipboard",     "Read text from the clipboard",                 1);
    TOOL("get_comm_port_state","Get COM port DCB state",                       1);
    TOOL("read_serial",        "Read bytes from a COM port",                   1);
    TOOL("write_serial",       "Write bytes to a COM port",                    1);
    TOOL("get_audio_devices",  "List waveIn audio devices",                    1);
    TOOL("get_midi_devices",   "List MIDI input devices",                      1);

#undef TOOL
    return arr;
}

/* ── Heartbeat timer ──────────────────────────────────────────────────────── */

static void heartbeat_tick(SOCKET sock)
{
    DWORD now = GetTickCount();
    cJSON *params;

    if (now - g_last_heartbeat_tick < HEARTBEAT_INTERVAL_MS) return;
    g_last_heartbeat_tick = now;

    params = cJSON_CreateObject();
    cJSON_AddNumberToObject(params, "uptime_ms", (double)now);
    send_notification(sock, "heartbeat", params);
}

/* ── MCP initialize handler ───────────────────────────────────────────────── */

static void handle_initialize(SOCKET sock, cJSON *id, cJSON *params)
{
    char   machine_guid[128] = "unknown";
    char   hostname[256]     = "unknown";
    HKEY   hkey;
    DWORD  buf_size;
    DWORD  type;

    /* Read MachineGuid from registry */
    if (RegOpenKeyEx(HKEY_LOCAL_MACHINE,
                     "SOFTWARE\\Microsoft\\Cryptography",
                     0, KEY_READ, &hkey) == ERROR_SUCCESS) {
        buf_size = (DWORD)sizeof(machine_guid);
        RegQueryValueEx(hkey, "MachineGuid", NULL, &type,
                        (LPBYTE)machine_guid, &buf_size);
        RegCloseKey(hkey);
    }

    /* Read computer name */
    buf_size = (DWORD)sizeof(hostname);
    GetComputerName(hostname, &buf_size);

    cJSON *result   = cJSON_CreateObject();
    cJSON *server_i = build_server_info();
    cJSON *startup  = do_startup_check();
    cJSON *perms_j  = permissions_to_json();
    cJSON *tools    = build_tools_list();

    cJSON_AddStringToObject(result, "machineGuid", machine_guid);
    cJSON_AddStringToObject(result, "hostname",    hostname);
    cJSON_AddItemToObject(result, "serverInfo",    server_i);
    cJSON_AddItemToObject(result, "startupCheck",  startup);
    cJSON_AddItemToObject(result, "permissions",   perms_j);
    cJSON_AddItemToObject(result, "tools",         tools);
    send_result(sock, id, result);

    (void)params;
}

/* ── Tool dispatch ────────────────────────────────────────────────────────── */

/*
 * Maps "tool_name" string → function pointer.
 * All tool functions have signature: cJSON *(cJSON *params)
 */
typedef cJSON *(*ToolFn)(cJSON *);

typedef struct {
    const char *name;
    ToolFn      fn;
} ToolEntry;

static cJSON *fn_file_exists(cJSON *p)        { return tool_file_exists(p); }

ToolEntry g_tools[] = {
    { "read_file",             tool_read_file          },
    { "write_file",            tool_write_file         },
    { "write_file_binary",     tool_write_file_binary  },
    { "append_file",           tool_append_file        },
    { "delete_file",           tool_delete_file        },
    { "copy_file",             tool_copy_file          },
    { "move_file",             tool_move_file          },
    { "get_file_info",         tool_get_file_info      },
    { "list_directory",        tool_list_directory     },
    { "grep_file",             tool_grep_file          },
    { "get_history",           tool_get_history        },
    { "file_exists",           fn_file_exists          },
    { "run_command",           tool_run_command        },
    { "run_bat",               tool_run_bat            },
    { "write_and_run_bat",     tool_write_and_run_bat  },
    { "start_command",         tool_start_command      },
    { "get_command_status",    tool_get_command_status },
    { "get_command_output",    tool_get_command_output },
    { "stop_command",          tool_stop_command       },
    { "schedule_task",         tool_schedule_task      },
    { "list_tasks",            tool_list_tasks         },
    { "delete_task",           tool_delete_task        },
    { "ini_read",              tool_ini_read           },
    { "ini_read_section",      tool_ini_read_section   },
    { "ini_list_sections",     tool_ini_list_sections  },
    { "ini_write",             tool_ini_write          },
    { "ini_delete_key",        tool_ini_delete_key     },
    { "read_registry",         tool_read_registry      },
    { "write_registry",        tool_write_registry     },
    { "delete_registry",       tool_delete_registry    },
    { "list_registry",         tool_list_registry      },
    { "list_processes",        tool_list_processes     },
    { "kill_process",          tool_kill_process       },
    { "get_system_info",       tool_get_system_info    },
    { "get_disk_info",         tool_get_disk_info      },
    { "get_screen_resolution", tool_get_screen_resolution },
    { "set_display_settings",  tool_set_display_settings  },
    { "set_desktop_appearance",tool_set_desktop_appearance},
    { "read_port",             tool_read_port          },
    { "write_port",            tool_write_port         },
    { "load_vxd",              tool_load_vxd           },
    { "get_window_list",       tool_get_window_list    },
    { "send_window_message",   tool_send_window_message},
    { "read_clipboard",        tool_read_clipboard     },
    { "get_comm_port_state",   tool_get_comm_port_state},
    { "read_serial",           tool_read_serial        },
    { "write_serial",          tool_write_serial       },
    { "get_audio_devices",     tool_get_audio_devices  },
    { "get_midi_devices",      tool_get_midi_devices   },
    { NULL,                    NULL                    }
};

static void dispatch_tools_call(SOCKET sock, cJSON *id, cJSON *params)
{
    cJSON *j_name;
    cJSON *j_args;
    const char *tool_name;
    ToolEntry  *entry;
    cJSON      *result;

    j_name = cJSON_GetObjectItemCaseSensitive(params, "name");
    j_args = cJSON_GetObjectItemCaseSensitive(params, "arguments");

    if (!cJSON_IsString(j_name)) {
        send_error(sock, id, -32602, "tool name required");
        return;
    }
    tool_name = j_name->valuestring;

    /* Check permissions */
    if (!permission_allowed(tool_name)) {
        send_error(sock, id, -32603, "permission_denied");
        return;
    }

    /* Look up tool */
    for (entry = g_tools; entry->name != NULL; entry++) {
        if (strcmp(entry->name, tool_name) == 0) {
            cJSON *args_safe = j_args ? j_args : cJSON_CreateObject();
            result = entry->fn(args_safe);
            if (!j_args) cJSON_Delete(args_safe);
            if (!result) {
                send_error(sock, id, -32603, "tool returned null");
                return;
            }
            send_result(sock, id, result);
            return;
        }
    }

    send_error(sock, id, -32601, "unknown_tool");
}

/* ── JSON-RPC dispatch ────────────────────────────────────────────────────── */

static void dispatch(SOCKET sock, cJSON *req)
{
    cJSON *j_method = cJSON_GetObjectItemCaseSensitive(req, "method");
    cJSON *j_id     = cJSON_GetObjectItemCaseSensitive(req, "id");
    cJSON *j_params = cJSON_GetObjectItemCaseSensitive(req, "params");

    if (!cJSON_IsString(j_method)) return;

    if (strcmp(j_method->valuestring, "initialize") == 0) {
        handle_initialize(sock, j_id, j_params);
    } else if (strcmp(j_method->valuestring, "tools/call") == 0) {
        if (!j_params) {
            send_error(sock, j_id, -32602, "params required");
            return;
        }
        dispatch_tools_call(sock, j_id, j_params);
    } else if (strcmp(j_method->valuestring, "tools/list") == 0) {
        cJSON *result = cJSON_CreateObject();
        cJSON_AddItemToObject(result, "tools", build_tools_list());
        send_result(sock, j_id, result);
    } else if (strcmp(j_method->valuestring, "permissions/update") == 0) {
        if (j_params) {
            /* Reload permissions from file (params may specify new path) */
            cJSON *j_path = cJSON_GetObjectItemCaseSensitive(j_params, "path");
            const char *path = cJSON_IsString(j_path) ? j_path->valuestring
                                                       : PERMISSIONS_INI;
            permissions_load(path);
        }
        send_result(sock, j_id, permissions_to_json());
    } else {
        /* Ignore unknown notifications; send error for requests */
        if (j_id && !cJSON_IsNull(j_id))
            send_error(sock, j_id, -32601, "method_not_found");
    }
}

/* ── Main receive/dispatch loop ───────────────────────────────────────────── */

static void main_loop(SOCKET sock)
{
    char *buf;
    int   buf_len;
    cJSON *req;

    agent_logf("INFO", "Connection established. Waiting for relay messages.");

    while (1) {
        /* Heartbeat check */
        heartbeat_tick(sock);

        /* Non-blocking check: try to receive with a short timeout */
        {
            fd_set fds;
            struct timeval tv;
            int sel;
            FD_ZERO(&fds);
            FD_SET(sock, &fds);
            tv.tv_sec  = 0;
            tv.tv_usec = 100 * 1000; /* 100 ms */
            sel = select(0, &fds, NULL, NULL, &tv);
            if (sel < 0) {
                agent_logf("ERROR", "select() failed: %d. Disconnecting.", WSAGetLastError());
                break;
            }
            if (sel == 0) continue; /* timeout: loop to check heartbeat */
        }

        buf = NULL;
        if (tcp_recv_msg(sock, &buf, &buf_len) != 0) {
            agent_logf("WARN", "Receive error. Relay disconnected.");
            if (buf) free(buf);
            break;
        }

        agent_log_debug("Received %d bytes from relay.", buf_len);

        req = cJSON_Parse(buf);
        free(buf);

        if (!req) {
            agent_logf("WARN", "JSON parse error. Ignoring malformed message.");
            continue;
        }

        dispatch(sock, req);
        cJSON_Delete(req);
    }
}

/* ── TCP connect with retries ─────────────────────────────────────────────── */

static SOCKET connect_to_relay(const char *host, int port, int retries)
{
    struct sockaddr_in addr;
    SOCKET sock;
    int    i;
    unsigned long ul_addr;

    addr.sin_family = AF_INET;
    addr.sin_port   = htons((u_short)port);

    ul_addr = inet_addr(host);
    if (ul_addr == INADDR_NONE) {
        struct hostent *he = gethostbyname(host);
        if (!he) {
            agent_logf("ERROR", "DNS resolve failed for %s.", host);
            return INVALID_SOCKET;
        }
        ul_addr = *(unsigned long *)he->h_addr_list[0];
    }
    addr.sin_addr.s_addr = ul_addr;

    for (i = 0; i < retries; i++) {
        sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (sock == INVALID_SOCKET) {
            agent_logf("ERROR", "socket() failed: %d.", WSAGetLastError());
            return INVALID_SOCKET;
        }
        agent_logf("INFO", "Connecting to %s:%d (attempt %d/%d)...",
                   host, port, i + 1, retries);
        if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
            agent_logf("INFO", "Connected to relay.");
            return sock;
        }
        agent_logf("WARN", "connect() failed: %d.", WSAGetLastError());
        closesocket(sock);
        Sleep(2000);
    }
    return INVALID_SOCKET;
}

/* ── Startup banner ───────────────────────────────────────────────────────── */

static void startup_banner(void)
{
    printf("=======================================================\n");
    printf("  %s v%s\n", SERVER_NAME, SERVER_VERSION);
    printf("  Windows 98SE MCP Agent\n");
    printf("  Relay: %s:%d\n", g_relay_host, g_relay_port);
    printf("  Base:  %s\n", BASE_DIR);
    printf("=======================================================\n");
}

/* ── Read relay connection params from AGENT.INI ─────────────────────────── */

static void load_config(void)
{
    char ini_path[MAX_PATH_BYTES];
    char val[MAX_PATH_BYTES];
    DWORD attr;

    _snprintf(ini_path, sizeof(ini_path), "%s\\AGENT.INI", BASE_DIR);
    attr = GetFileAttributesA(ini_path);
    if (attr == INVALID_FILE_ATTRIBUTES) return;

    GetPrivateProfileStringA("relay", "host", g_relay_host,
                             val, sizeof(val), ini_path);
    val[sizeof(val) - 1] = '\0';
    memcpy(g_relay_host, val, sizeof(g_relay_host) - 1);
    g_relay_host[sizeof(g_relay_host) - 1] = '\0';

    GetPrivateProfileStringA("relay", "port", "9000",
                             val, sizeof(val), ini_path);
    g_relay_port = atoi(val);
    if (g_relay_port <= 0 || g_relay_port > 65535) g_relay_port = 9000;

    GetPrivateProfileStringA("logging", "enabled", "1",
                             val, sizeof(val), ini_path);
    g_log_enabled = parse_bool_str(val, 1);

    GetPrivateProfileStringA("logging", "verbose", "0",
                             val, sizeof(val), ini_path);
    g_log_verbose = parse_bool_str(val, 0);

    GetPrivateProfileStringA("logging", "path", AGENT_LOG,
                             val, sizeof(val), ini_path);
    val[sizeof(val) - 1] = '\0';
    memcpy(g_log_path, val, sizeof(g_log_path) - 1);
    g_log_path[sizeof(g_log_path) - 1] = '\0';
}

/* ── main ─────────────────────────────────────────────────────────────────── */

int main(int argc, char *argv[])
{
    WSADATA wsa;
    SOCKET  sock;
    int     reconnect = 1;
    int     run_as_service = 0;
    int     i;

    /* ── Service-mode flags ───────────────────────────────────────────────
     *
     *  -service   : hide console + register as Win9x background service
     *  -install   : write autorun registry key and exit
     *  -uninstall : remove autorun registry key and exit
     *
     * Win9x RegisterServiceProcess() hides this process from Ctrl+Alt+Del.
     * Combined with FreeConsole() the agent is completely invisible to the
     * casual user. The relay can still connect and issue commands at any time.
     */
    typedef DWORD (WINAPI *RSP_t)(DWORD, DWORD);
    for (i = 1; i < argc; i++) {
        if (lstrcmpiA(argv[i], "-cli") == 0) {
            /* CLI mode: send command to IPC pipe and exit immediately */
            return cli_mode_run(argc - i, argv + i);
        } else if (lstrcmpiA(argv[i], "-service") == 0) {
            run_as_service = 1;
        } else if (lstrcmpiA(argv[i], "-install") == 0) {
            /* Write: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run\Win98MCPServer */
            char exe_path[MAX_PATH];
            char cmd_line[MAX_PATH + 32];
            HKEY hk;
            GetModuleFileNameA(NULL, exe_path, sizeof(exe_path));
            wsprintfA(cmd_line, "\"%s\" -service", exe_path);
            if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
                    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
                    0, KEY_SET_VALUE, &hk) == ERROR_SUCCESS) {
                RegSetValueExA(hk, "Win98MCPServer", 0, REG_SZ,
                    (const BYTE *)cmd_line, lstrlenA(cmd_line) + 1);
                RegCloseKey(hk);
                MessageBoxA(NULL,
                    "Win98 MCP Server installed.\nIt will start automatically at next login.",
                    "MCP Server", MB_OK | MB_ICONINFORMATION);
            } else {
                MessageBoxA(NULL, "Failed to write registry key.",
                    "MCP Server", MB_OK | MB_ICONERROR);
            }
            return 0;
        } else if (lstrcmpiA(argv[i], "-uninstall") == 0) {
            HKEY hk;
            if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
                    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
                    0, KEY_SET_VALUE, &hk) == ERROR_SUCCESS) {
                RegDeleteValueA(hk, "Win98MCPServer");
                RegCloseKey(hk);
                MessageBoxA(NULL,
                    "Win98 MCP Server removed from startup.",
                    "MCP Server", MB_OK | MB_ICONINFORMATION);
            }
            return 0;
        }
    }

    if (run_as_service) {
        /* Hide from Ctrl+Alt+Del task list (Win9x only API) */
        HMODULE hKernel = GetModuleHandleA("kernel32.dll");
        if (hKernel) {
            RSP_t pRSP = (RSP_t)GetProcAddress(hKernel, "RegisterServiceProcess");
            if (pRSP) pRSP(GetCurrentProcessId(), 1 /* RSP_SIMPLE_SERVICE */);
        }
        /* Detach from console so no window appears */
        FreeConsole();
    }

    g_log_console = run_as_service ? 0 : 1;

    /* Ensure base directories exist */
    CreateDirectoryA(BASE_DIR,   NULL);
    CreateDirectoryA(BACKUP_DIR, NULL);
    CreateDirectoryA(TEMP_DIR,   NULL);

    /* Load config */
    load_config();

    /* Allow command-line override of host/port (after flag parsing) */
    if (argc >= 2 && argv[1][0] != '-') strncpy(g_relay_host, argv[1], sizeof(g_relay_host) - 1);
    if (argc >= 3 && argv[2][0] != '-') {
        int p = atoi(argv[2]);
        if (p > 0 && p <= 65535) g_relay_port = p;
    }

    agent_logf("INFO", "Starting %s v%s | relay=%s:%d | base=%s | service=%d | verbose=%d | log=%s",
               SERVER_NAME, SERVER_VERSION, g_relay_host, g_relay_port,
               BASE_DIR, run_as_service, g_log_verbose, g_log_path);

    if (!run_as_service) startup_banner();

    /* Init WinSock */
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        agent_logf("ERROR", "WSAStartup failed: %d.", WSAGetLastError());
        return 1;
    }
    agent_logf("INFO", "WinSock initialized: %s", wsa.szDescription);

    /* Load permissions */
    permissions_load(PERMISSIONS_INI);
    agent_logf("INFO", "Permissions loaded from %s", PERMISSIONS_INI);

    /* Start IPC (named pipe) server if running as service */
    HANDLE hIPCServer = NULL;
    if (run_as_service) {
        hIPCServer = ipc_server_start();
        agent_logf("INFO", "Local IPC server started for CLI/VB6 commands.");
    }

    /* Reconnect loop */
    while (reconnect) {
        sock = connect_to_relay(g_relay_host, g_relay_port, 3);
        if (sock == INVALID_SOCKET) {
            agent_logf("WARN", "Could not connect to relay. Retrying in 10 seconds.");
            Sleep(10000);
            continue;
        }

        g_last_heartbeat_tick = GetTickCount();
        main_loop(sock);
        closesocket(sock);

        agent_logf("WARN", "Disconnected from relay. Reconnecting in 5 seconds.");
        Sleep(5000);
    }

    /* Stop IPC server if it was started */
    if (hIPCServer) {
        ipc_server_stop(hIPCServer);
    }

    WSACleanup();
    return 0;
}
