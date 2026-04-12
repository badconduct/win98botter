/*
 * ipc_ops.c - Named pipe server for local IPC
 *
 * Listens on \\.\pipe\Win98MCPServer for local commands from VB6 or CLI.
 * Uses the same JSON-RPC format as TCP, with 4-byte big-endian length prefix.
 * Runs in a background thread to avoid blocking the main TCP connection.
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <process.h>

#include "cJSON.h"
#include "config.h"
#include "permissions.h"
#include "file_ops.h"
#include "exec_ops.h"
#include "ini_ops.h"
#include "registry_ops.h"
#include "process_ops.h"
#include "system_ops.h"

#define IPC_PIPE_NAME   "\\\\.\\pipe\\Win98MCPServer"
#define IPC_PIPE_INSTANCES 4

/* Forward declaration of ToolEntry from mcp_server.c */
typedef cJSON *(*ToolFn)(cJSON *);
typedef struct {
    const char *name;
    ToolFn      fn;
} ToolEntry;

/* External declarations (from mcp_server.c) */
extern ToolEntry *g_tools;

/* Global flag to signal server shutdown */
static int g_ipc_shutdown = 0;

/* Forward declarations */
static void ipc_dispatch(HANDLE hPipe, cJSON *req);
static void ipc_send_msg(HANDLE hPipe, cJSON *msg);
static int  ipc_recv_msg(HANDLE hPipe, char **out_buf, int *out_len);
static unsigned __stdcall ipc_worker_thread(void *arg);
static void ipc_send_result(HANDLE hPipe, cJSON *id, cJSON *result);
static void ipc_send_error(HANDLE hPipe, cJSON *id, int code, const char *message);

/* ── Framing (same as TCP) ────────────────────────────────────────────────── */

static void ipc_send_msg(HANDLE hPipe, cJSON *msg)
{
    char *json_str;
    DWORD len;
    unsigned char hdr[4];
    DWORD written;

    json_str = cJSON_PrintUnformatted(msg);
    if (!json_str) return;

    len = (DWORD)strlen(json_str);

    /* 4-byte big-endian length prefix */
    hdr[0] = (unsigned char)((len >> 24) & 0xFF);
    hdr[1] = (unsigned char)((len >> 16) & 0xFF);
    hdr[2] = (unsigned char)((len >>  8) & 0xFF);
    hdr[3] = (unsigned char)((len      ) & 0xFF);

    WriteFile(hPipe, hdr, 4, &written, NULL);
    WriteFile(hPipe, json_str, len, &written, NULL);
    free(json_str);
}

static int ipc_recv_msg(HANDLE hPipe, char **out_buf, int *out_len)
{
    unsigned char hdr[4];
    DWORD msg_len;
    DWORD read;
    char *buf;
    DWORD total;
    int done;

    /* Receive 4-byte header */
    total = 0;
    while (total < 4) {
        if (!ReadFile(hPipe, hdr + total, 4 - total, &read, NULL) || read == 0)
            return -1;
        total += read;
    }

    /* Parse big-endian length */
    msg_len = ((DWORD)hdr[0] << 24) | ((DWORD)hdr[1] << 16) |
              ((DWORD)hdr[2] << 8) | ((DWORD)hdr[3]);

    if (msg_len > 1000000) return -1; /* Sanity check */

    buf = (char *)malloc(msg_len + 1);
    if (!buf) return -1;

    total = 0;
    while (total < msg_len) {
        done = ReadFile(hPipe, buf + total, msg_len - total, &read, NULL);
        if (!done || read == 0) {
            free(buf);
            return -1;
        }
        total += read;
    }
    buf[msg_len] = '\0';

    *out_buf = buf;
    *out_len = (int)msg_len;
    return 0;
}

/* ── JSON-RPC helpers ─────────────────────────────────────────────────────── */

static void ipc_send_result(HANDLE hPipe, cJSON *id, cJSON *result)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    else    cJSON_AddNullToObject(msg, "id");
    cJSON_AddItemToObject(msg, "result", result);
    ipc_send_msg(hPipe, msg);
    cJSON_Delete(msg);
}

static void ipc_send_error(HANDLE hPipe, cJSON *id, int code, const char *message)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON *err = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    else    cJSON_AddNullToObject(msg, "id");
    cJSON_AddNumberToObject(err, "code",    (double)code);
    cJSON_AddStringToObject(err, "message", message);
    cJSON_AddItemToObject(msg, "error", err);
    ipc_send_msg(hPipe, msg);
    cJSON_Delete(msg);
}

/* ── Tool dispatch (same as TCP) ───────────────────────────────────────── */

static void ipc_dispatch_tools_call(HANDLE hPipe, cJSON *id, cJSON *params)
{
    cJSON *j_name;
    cJSON *j_args;
    const char *tool_name;
    ToolEntry *entry;
    cJSON *result;

    j_name = cJSON_GetObjectItemCaseSensitive(params, "name");
    j_args = cJSON_GetObjectItemCaseSensitive(params, "arguments");

    if (!cJSON_IsString(j_name)) {
        ipc_send_error(hPipe, id, -32602, "tool name required");
        return;
    }
    tool_name = j_name->valuestring;

    /* Check permissions */
    if (!permission_allowed(tool_name)) {
        ipc_send_error(hPipe, id, -32603, "permission_denied");
        return;
    }

    /* Look up tool */
    for (entry = g_tools; entry->name != NULL; entry++) {
        if (strcmp(entry->name, tool_name) == 0) {
            cJSON *args_safe = j_args ? j_args : cJSON_CreateObject();
            result = entry->fn(args_safe);
            if (!j_args) cJSON_Delete(args_safe);
            if (!result) {
                ipc_send_error(hPipe, id, -32603, "tool returned null");
                return;
            }
            ipc_send_result(hPipe, id, result);
            return;
        }
    }

    ipc_send_error(hPipe, id, -32601, "unknown_tool");
}

/* ── JSON-RPC dispatch ─────────────────────────────────────────────────── */

static void ipc_dispatch(HANDLE hPipe, cJSON *req)
{
    cJSON *j_method = cJSON_GetObjectItemCaseSensitive(req, "method");
    cJSON *j_id     = cJSON_GetObjectItemCaseSensitive(req, "id");
    cJSON *j_params = cJSON_GetObjectItemCaseSensitive(req, "params");

    if (!cJSON_IsString(j_method)) return;

    if (strcmp(j_method->valuestring, "tools/call") == 0) {
        if (!j_params) {
            ipc_send_error(hPipe, j_id, -32602, "params required");
            return;
        }
        ipc_dispatch_tools_call(hPipe, j_id, j_params);
    } else if (strcmp(j_method->valuestring, "tools/list") == 0) {
        /* Build tools list (external function from mcp_server.c) */
        cJSON *result = cJSON_CreateObject();
        cJSON *tools_arr = cJSON_CreateArray();
        ToolEntry *entry;
        for (entry = g_tools; entry->name != NULL; entry++) {
            if (permission_allowed(entry->name)) {
                cJSON *tool_obj = cJSON_CreateObject();
                cJSON_AddStringToObject(tool_obj, "name", entry->name);
                cJSON_AddItemToArray(tools_arr, tool_obj);
            }
        }
        cJSON_AddItemToObject(result, "tools", tools_arr);
        ipc_send_result(hPipe, j_id, result);
    } else {
        if (j_id && !cJSON_IsNull(j_id))
            ipc_send_error(hPipe, j_id, -32601, "method_not_found");
    }
}

/* ── Worker thread ────────────────────────────────────────────────────────── */

static unsigned __stdcall ipc_worker_thread(void *arg)
{
    HANDLE hServerPipe;
    HANDLE hEvent = (HANDLE)arg;

    /* Create a named pipe instance for listening */
    hServerPipe = CreateNamedPipeA(
        IPC_PIPE_NAME,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        IPC_PIPE_INSTANCES,
        4096, 4096, 0, NULL
    );

    if (hServerPipe == INVALID_HANDLE_VALUE) {
        if (hEvent) SetEvent(hEvent);
        return 1;
    }

    /* Signal that the pipe is ready */
    if (hEvent) SetEvent(hEvent);

    /* Main accept loop */
    while (!g_ipc_shutdown) {
        char *buf;
        int buf_len;
        cJSON *req;

        /* Accept connection */
        if (!ConnectNamedPipe(hServerPipe, NULL)) {
            if (GetLastError() != ERROR_PIPE_CONNECTED) {
                Sleep(100);
                continue;
            }
        }

        /* Handle client request */
        if (ipc_recv_msg(hServerPipe, &buf, &buf_len) == 0) {
            req = cJSON_Parse(buf);
            if (req) {
                ipc_dispatch(hServerPipe, req);
                cJSON_Delete(req);
            }
            free(buf);
        }

        /* Disconnect and wait for next client */
        DisconnectNamedPipe(hServerPipe);
    }

    CloseHandle(hServerPipe);
    return 0;
}

/* ── Public API ────────────────────────────────────────────────────────────── */

HANDLE ipc_server_start(void)
{
    HANDLE hThread;
    HANDLE hEvent;

    g_ipc_shutdown = 0;

    /* Create an event to signal when the pipe is ready */
    hEvent = CreateEventA(NULL, 1, 0, NULL);

    /* Start the worker thread */
    hThread = (HANDLE)_beginthreadex(NULL, 0, ipc_worker_thread, hEvent, 0, NULL);
    if (!hThread) {
        if (hEvent) CloseHandle(hEvent);
        return NULL;
    }

    /* Wait for the pipe to be created */
    if (hEvent) {
        WaitForSingleObject(hEvent, 5000);
        CloseHandle(hEvent);
    }

    return hThread;
}

void ipc_server_stop(HANDLE hThread)
{
    if (!hThread) return;

    g_ipc_shutdown = 1;
    WaitForSingleObject(hThread, 5000);
    CloseHandle(hThread);
}
