/*
 * ipc_ops.c - Local TCP server for local IPC
 *
 * Listens on 127.0.0.1:IPC_PORT for local commands from VB6 or CLI.
 * Uses the same JSON-RPC format as TCP, with 4-byte big-endian length prefix.
 * Runs in a background thread to avoid blocking the main TCP connection.
 */

#include <windows.h>
#include <winsock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

/* Forward declaration of ToolEntry from mcp_server.c */
typedef cJSON *(*ToolFn)(cJSON *);
typedef struct {
    const char *name;
    ToolFn      fn;
} ToolEntry;

/* External declarations (from mcp_server.c) */
extern ToolEntry *g_tools;
extern void agent_logf(const char *level, const char *fmt, ...);

/* Global flag to signal server shutdown */
static int g_ipc_shutdown = 0;

/* Forward declarations */
static void ipc_dispatch(SOCKET sock, cJSON *req);
static void ipc_send_msg(SOCKET sock, cJSON *msg);
static int  ipc_recv_msg(SOCKET sock, char **out_buf, int *out_len);
static DWORD WINAPI ipc_worker_thread(LPVOID arg);
static void ipc_send_result(SOCKET sock, cJSON *id, cJSON *result);
static void ipc_send_error(SOCKET sock, cJSON *id, int code, const char *message);

/* ── Framing (same as TCP) ────────────────────────────────────────────────── */

static void ipc_send_msg(SOCKET sock, cJSON *msg)
{
    char *json_str;
    DWORD len;
    unsigned char hdr[4];

    json_str = cJSON_PrintUnformatted(msg);
    if (!json_str) return;

    len = (DWORD)strlen(json_str);

    /* 4-byte big-endian length prefix */
    hdr[0] = (unsigned char)((len >> 24) & 0xFF);
    hdr[1] = (unsigned char)((len >> 16) & 0xFF);
    hdr[2] = (unsigned char)((len >>  8) & 0xFF);
    hdr[3] = (unsigned char)((len      ) & 0xFF);

    send(sock, (const char *)hdr, 4, 0);
    send(sock, json_str, len, 0);
    free(json_str);
}

static int ipc_recv_msg(SOCKET sock, char **out_buf, int *out_len)
{
    unsigned char hdr[4];
    DWORD msg_len;
    int read;
    char *buf;
    DWORD total;

    /* Receive 4-byte header */
    total = 0;
    while (total < 4) {
        read = recv(sock, (char *)hdr + total, 4 - total, 0);
        if (read <= 0) return -1;
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
        read = recv(sock, buf + total, msg_len - total, 0);
        if (read <= 0) {
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

static void ipc_send_result(SOCKET sock, cJSON *id, cJSON *result)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    else    cJSON_AddNullToObject(msg, "id");
    cJSON_AddItemToObject(msg, "result", result);
    ipc_send_msg(sock, msg);
    cJSON_Delete(msg);
}

static void ipc_send_error(SOCKET sock, cJSON *id, int code, const char *message)
{
    cJSON *msg = cJSON_CreateObject();
    cJSON *err = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    else    cJSON_AddNullToObject(msg, "id");
    cJSON_AddNumberToObject(err, "code",    (double)code);
    cJSON_AddStringToObject(err, "message", message);
    cJSON_AddItemToObject(msg, "error", err);
    ipc_send_msg(sock, msg);
    cJSON_Delete(msg);
}

/* ── Tool dispatch (same as TCP) ───────────────────────────────────────── */

static void ipc_dispatch_tools_call(SOCKET sock, cJSON *id, cJSON *params)
{
    cJSON *j_name;
    cJSON *j_args;
    const char *tool_name;
    ToolEntry *entry;
    cJSON *result;
    cJSON *args_safe;
    DWORD t0;
    DWORD t1;

    j_name = cJSON_GetObjectItemCaseSensitive(params, "name");
    j_args = cJSON_GetObjectItemCaseSensitive(params, "arguments");

    if (!cJSON_IsString(j_name)) {
        ipc_send_error(sock, id, -32602, "tool name required");
        return;
    }
    tool_name = j_name->valuestring;
    t0 = GetTickCount();

    agent_logf("INFO", "IPC tools/call requested: %s", tool_name);

    /* Check permissions */
    if (!permission_allowed(tool_name)) {
        agent_logf("WARN", "IPC tools/call denied by permissions: %s", tool_name);
        ipc_send_error(sock, id, -32603, "permission_denied");
        return;
    }

    /* Look up tool */
    for (entry = g_tools; entry->name != NULL; entry++) {
        if (strcmp(entry->name, tool_name) == 0) {
            args_safe = j_args ? j_args : cJSON_CreateObject();
            result = entry->fn(args_safe);
            if (!j_args) cJSON_Delete(args_safe);
            if (!result) {
                t1 = GetTickCount();
                agent_logf("ERROR", "IPC tools/call failed: %s returned null (%lu ms)",
                           tool_name, (unsigned long)(t1 - t0));
                ipc_send_error(sock, id, -32603, "tool returned null");
                return;
            }

            t1 = GetTickCount();
            agent_logf("INFO", "IPC tools/call completed: %s (%lu ms)",
                       tool_name, (unsigned long)(t1 - t0));
            ipc_send_result(sock, id, result);
            return;
        }
    }

    agent_logf("WARN", "IPC tools/call unknown tool: %s", tool_name);
    ipc_send_error(sock, id, -32601, "unknown_tool");
}

/* ── JSON-RPC dispatch ─────────────────────────────────────────────────── */

static void ipc_dispatch(SOCKET sock, cJSON *req)
{
    cJSON *j_method = cJSON_GetObjectItemCaseSensitive(req, "method");
    cJSON *j_id     = cJSON_GetObjectItemCaseSensitive(req, "id");
    cJSON *j_params = cJSON_GetObjectItemCaseSensitive(req, "params");
    cJSON *result;
    cJSON *tools_arr;
    cJSON *tool_obj;
    ToolEntry *entry;

    if (!cJSON_IsString(j_method)) return;

    if (strcmp(j_method->valuestring, "tools/call") == 0) {
        if (!j_params) {
            ipc_send_error(sock, j_id, -32602, "params required");
            return;
        }
        ipc_dispatch_tools_call(sock, j_id, j_params);
    } else if (strcmp(j_method->valuestring, "tools/list") == 0) {
        /* Build tools list (external function from mcp_server.c) */
        result = cJSON_CreateObject();
        tools_arr = cJSON_CreateArray();
        for (entry = g_tools; entry->name != NULL; entry++) {
            if (permission_allowed(entry->name)) {
                tool_obj = cJSON_CreateObject();
                cJSON_AddStringToObject(tool_obj, "name", entry->name);
                cJSON_AddItemToArray(tools_arr, tool_obj);
            }
        }
        cJSON_AddItemToObject(result, "tools", tools_arr);
        ipc_send_result(sock, j_id, result);
    } else {
        if (j_id && !cJSON_IsNull(j_id))
            ipc_send_error(sock, j_id, -32601, "method_not_found");
    }
}

/* ── Worker thread ────────────────────────────────────────────────────────── */

static DWORD WINAPI ipc_worker_thread(LPVOID arg)
{
    SOCKET server_sock;
    struct sockaddr_in addr;
    HANDLE  hEvent;
    LONG   *pReady;

    hEvent = ((HANDLE *)arg)[0];
    pReady = (LONG *)((HANDLE *)arg)[1];

    /* Create TCP socket */
    server_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server_sock == INVALID_SOCKET) {
        agent_logf("ERROR", "IPC socket create failed.");
        *pReady = 0;
        if (hEvent) SetEvent(hEvent);
        return 1;
    }

    addr.sin_family = AF_INET;
    addr.sin_port = htons(IPC_PORT);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (bind(server_sock, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        agent_logf("ERROR", "IPC socket bind failed: %d", WSAGetLastError());
        closesocket(server_sock);
        *pReady = 0;
        if (hEvent) SetEvent(hEvent);
        return 1;
    }

    if (listen(server_sock, SOMAXCONN) != 0) {
        agent_logf("ERROR", "IPC socket listen failed: %d", WSAGetLastError());
        closesocket(server_sock);
        *pReady = 0;
        if (hEvent) SetEvent(hEvent);
        return 1;
    }

    agent_logf("INFO", "IPC local TCP server ready on 127.0.0.1:%d", IPC_PORT);
    *pReady = 1;

    /* Signal that the server is ready */
    if (hEvent) SetEvent(hEvent);

    /* Main accept loop */
    while (!g_ipc_shutdown) {
        struct sockaddr_in client_addr;
        int client_len = sizeof(client_addr);
        SOCKET client_sock;
        
        /* Accept connection. In a real robust implementation we might use select() 
           here so we can wake up on shutdown, but testing shows this is fine for now
           as shutting down is just terminating the process on Win98. */
        client_sock = accept(server_sock, (struct sockaddr *)&client_addr, &client_len);
        if (client_sock == INVALID_SOCKET) {
            Sleep(100);
            continue;
        }

        agent_logf("INFO", "IPC client connected.");

        /* Handle client request (synchronous for simplicity) */
        {
            char *buf;
            int buf_len;
            cJSON *req;

            if (ipc_recv_msg(client_sock, &buf, &buf_len) == 0) {
                req = cJSON_Parse(buf);
                if (req) {
                    ipc_dispatch(client_sock, req);
                    cJSON_Delete(req);
                }
                free(buf);
            }
        }

        /* Disconnect and wait for next client */
        closesocket(client_sock);
        agent_logf("INFO", "IPC client disconnected.");
    }

    closesocket(server_sock);
    return 0;
}

/* ── Public API ────────────────────────────────────────────────────────────── */

HANDLE ipc_server_start(void)
{
    HANDLE hThread;
    HANDLE hEvent;
    DWORD threadId;
    LONG   ready;
    HANDLE args[2];

    g_ipc_shutdown = 0;

    /* Create an event to signal when the socket is ready */
    hEvent = CreateEventA(NULL, 1, 0, NULL);

    /* Pass event handle and ready flag pointer to the worker thread */
    ready    = -1;
    args[0]  = hEvent;
    args[1]  = (HANDLE)&ready;

    /* Start the worker thread */
    hThread = CreateThread(NULL, 0, ipc_worker_thread, args, 0, &threadId);
    if (!hThread) {
        if (hEvent) CloseHandle(hEvent);
        return NULL;
    }

    /* Wait for the server socket to be created */
    if (hEvent) {
        WaitForSingleObject(hEvent, 5000);
        CloseHandle(hEvent);
    }

    /* ready==1: server came up; ready==0: bind failed; -1: timeout */
    if (ready != 1) {
        agent_logf("WARN", "IPC server thread started but socket failed (ready=%ld).", ready);
        return NULL;
    }
    return hThread;
}

void ipc_server_stop(HANDLE hThread)
{
    if (!hThread) return;

    g_ipc_shutdown = 1;
    /* Clean shutdown would require closing the server socket from here 
       so accept() unblocks, but process exit does it anyway. */
    WaitForSingleObject(hThread, 5000);
    CloseHandle(hThread);
}
