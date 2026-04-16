/*
 * cli_mode.c - Command-line interface for the MCP server
 *
 * Connects to the local TCP port (127.0.0.1:IPC_PORT) and sends a JSON-RPC request.
 * Maps simple command syntax to JSON-RPC format.
 */

#include <windows.h>
#include <winsock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "config.h"
#include "permissions.h"

/* Forward declaration of ToolEntry from mcp_server.c */
typedef cJSON *(*ToolFn)(cJSON *);
typedef struct {
    const char *name;
    ToolFn      fn;
} ToolEntry;

/* External tool registry from mcp_server.c */
extern ToolEntry g_tools[];

/* Forward declarations */
static int  cli_connect_and_send(cJSON *req, cJSON **out_result);
static int  cli_execute_local(cJSON *req, cJSON **out_result);
static void cli_print_result(cJSON *result);
static cJSON *cli_parse_command(int argc, char *argv[]);

static const char *cli_unwrap_json_arg(const char *s)
{
    size_t len;
    if (!s) return s;
    len = strlen(s);
    if (len >= 2) {
        if ((s[0] == '\'' && s[len - 1] == '\'') ||
            (s[0] == '"' && s[len - 1] == '"')) {
            static char tmp[8192];
            size_t copy_len = len - 2;
            if (copy_len >= sizeof(tmp)) copy_len = sizeof(tmp) - 1;
            memcpy(tmp, s + 1, copy_len);
            tmp[copy_len] = '\0';
            return tmp;
        }
    }
    return s;
}

/* ── Framing (same as TCP/IPC) ────────────────────────────────────────────── */

static int cli_send_msg(SOCKET sock, cJSON *msg)
{
    char *json_str;
    DWORD len;
    unsigned char hdr[4];
    int written;

    json_str = cJSON_PrintUnformatted(msg);
    if (!json_str) return -1;

    len = (DWORD)strlen(json_str);

    /* 4-byte big-endian length prefix */
    hdr[0] = (unsigned char)((len >> 24) & 0xFF);
    hdr[1] = (unsigned char)((len >> 16) & 0xFF);
    hdr[2] = (unsigned char)((len >>  8) & 0xFF);
    hdr[3] = (unsigned char)((len      ) & 0xFF);

    written = send(sock, (const char *)hdr, 4, 0);
    if (written != 4) {
        free(json_str);
        return -1;
    }

    written = send(sock, json_str, (int)len, 0);
    if (written != (int)len) {
        free(json_str);
        return -1;
    }

    free(json_str);
    return 0;
}

static int cli_recv_msg(SOCKET sock, char **out_buf, int *out_len)
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

    if (msg_len > 1000000) return -1;

    buf = (char *)malloc(msg_len + 1);
    if (!buf) return -1;

    total = 0;
    while (total < msg_len) {
        read = recv(sock, buf + total, (int)(msg_len - total), 0);
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

/* ── Command parsing ──────────────────────────────────────────────────────── */

static cJSON *cli_parse_command(int argc, char *argv[])
{
    cJSON *req;
    cJSON *params;
    cJSON *args;

    /* Usage:
     *   mcp-server -cli tools/call "{"name":"read_file","arguments":{"path":"C:\\file.txt"}}"
     *   mcp-server -cli tools/list
     *   mcp-server -cli read-file "C:\path.txt"
     *   mcp-server -cli write-file "C:\path.txt" "content"
     *   mcp-server -cli run-command "dir C:\"
     */

    if (argc < 2) {
        fprintf(stderr, "Usage: mcp-server -cli <method> [args...]\n");
        return NULL;
    }

    /* If method starts with '{', treat as raw JSON-RPC request */
    if (argv[1][0] == '{') {
        return cJSON_Parse(argv[1]);
    }

    /* Helper shorthand commands */
    if (strcmp(argv[1], "read-file") == 0) {
        if (argc < 3) {
            fprintf(stderr, "read-file: path required\n");
            return NULL;
        }
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", "tools/call");
        params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "read_file");
        args = cJSON_CreateObject();
        cJSON_AddStringToObject(args, "path", argv[2]);
        cJSON_AddItemToObject(params, "arguments", args);
        cJSON_AddItemToObject(req, "params", params);
        return req;
    }

    if (strcmp(argv[1], "file-exists") == 0) {
        if (argc < 3) {
            fprintf(stderr, "file-exists: path required\n");
            return NULL;
        }
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", "tools/call");
        params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "file_exists");
        args = cJSON_CreateObject();
        cJSON_AddStringToObject(args, "path", argv[2]);
        cJSON_AddItemToObject(params, "arguments", args);
        cJSON_AddItemToObject(req, "params", params);
        return req;
    }

    if (strcmp(argv[1], "write-file") == 0) {
        if (argc < 4) {
            fprintf(stderr, "write-file: path and content required\n");
            return NULL;
        }
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", "tools/call");
        params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "write_file");
        args = cJSON_CreateObject();
        cJSON_AddStringToObject(args, "path", argv[2]);
        cJSON_AddStringToObject(args, "content", argv[3]);
        cJSON_AddItemToObject(params, "arguments", args);
        cJSON_AddItemToObject(req, "params", params);
        return req;
    }

    if (strcmp(argv[1], "run-command") == 0) {
        if (argc < 3) {
            fprintf(stderr, "run-command: command required\n");
            return NULL;
        }
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", "tools/call");
        params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "run_command");
        args = cJSON_CreateObject();
        cJSON_AddStringToObject(args, "command", argv[2]);
        cJSON_AddItemToObject(params, "arguments", args);
        cJSON_AddItemToObject(req, "params", params);
        return req;
    }

    if (strcmp(argv[1], "list-processes") == 0) {
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", "tools/call");
        params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "list_processes");
        args = cJSON_CreateObject();
        cJSON_AddItemToObject(params, "arguments", args);
        cJSON_AddItemToObject(req, "params", params);
        return req;
    }

    if (strcmp(argv[1], "tools/list") == 0) {
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", "tools/list");
        return req;
    }

    /* Generic: treat as method with remaining args as JSON params */
    if (argc >= 3) {
        const char *json_arg = cli_unwrap_json_arg(argv[2]);
        if (json_arg && json_arg[0] == '{') {
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", argv[1]);
            cJSON_AddItemToObject(req, "params", cJSON_Parse(json_arg));
        return req;
        }
    }

    fprintf(stderr, "Unknown command: %s\n", argv[1]);
    return NULL;
}

/* ── Connect and send ─────────────────────────────────────────────────────── */

static int cli_connect_and_send(cJSON *req, cJSON **out_result)
{
    SOCKET sock = INVALID_SOCKET;
    struct sockaddr_in addr;
    char *buf;
    int buf_len;
    cJSON *result;
    int retries = 3;

    if (!req || !out_result) return -1;

    /* Try to connect to the local IPC port */
    while (retries > 0) {
        sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (sock != INVALID_SOCKET) {
            addr.sin_family = AF_INET;
            addr.sin_port = htons(IPC_PORT);
            addr.sin_addr.s_addr = inet_addr("127.0.0.1");

            if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
                break;
            }
            closesocket(sock);
            sock = INVALID_SOCKET;
        }

        retries--;
        if (retries > 0) Sleep(500);
    }

    if (sock == INVALID_SOCKET) {
        fprintf(stderr, "Error: MCP Server not running on IPC port\n");
        return -1;
    }

    /* Send request */
    if (cli_send_msg(sock, req) != 0) {
        fprintf(stderr, "Error: Failed to send request\n");
        closesocket(sock);
        return -1;
    }

    /* Receive response */
    if (cli_recv_msg(sock, &buf, &buf_len) != 0) {
        fprintf(stderr, "Error: Failed to receive response\n");
        closesocket(sock);
        return -1;
    }

    closesocket(sock);

    /* Parse response */
    result = cJSON_Parse(buf);
    free(buf);

    if (!result) {
        fprintf(stderr, "Error: Invalid JSON response\n");
        return -1;
    }

    *out_result = result;
    return 0;
}

/* ── Local fallback execution (no IPC, no relay) ─────────────────────────── */

static int cli_execute_local(cJSON *req, cJSON **out_result)
{
    cJSON *method;
    cJSON *id;
    cJSON *params;
    cJSON *name;
    cJSON *args;
    cJSON *result;
    cJSON *tools;
    cJSON *tool_obj;
    ToolEntry *entry;
    const char *tool_name;
    cJSON *tool_result;

    if (!req || !out_result) return -1;

    method = cJSON_GetObjectItemCaseSensitive(req, "method");
    id = cJSON_GetObjectItemCaseSensitive(req, "id");
    params = cJSON_GetObjectItemCaseSensitive(req, "params");

    if (!cJSON_IsString(method)) {
        fprintf(stderr, "Error: local CLI requires JSON-RPC method\n");
        return -1;
    }

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "jsonrpc", "2.0");
    if (id) cJSON_AddItemToObject(result, "id", cJSON_Duplicate(id, 1));
    else cJSON_AddNullToObject(result, "id");

    if (strcmp(method->valuestring, "tools/list") == 0) {
        cJSON *payload = cJSON_CreateObject();
        tools = cJSON_CreateArray();
        for (entry = g_tools; entry && entry->name != NULL; entry++) {
            if (permission_allowed(entry->name)) {
                tool_obj = cJSON_CreateObject();
                cJSON_AddStringToObject(tool_obj, "name", entry->name);
                cJSON_AddItemToArray(tools, tool_obj);
            }
        }
        cJSON_AddItemToObject(payload, "tools", tools);
        cJSON_AddItemToObject(result, "result", payload);
        *out_result = result;
        return 0;
    }

    if (strcmp(method->valuestring, "tools/call") == 0) {
        name = params ? cJSON_GetObjectItemCaseSensitive(params, "name") : NULL;
        args = params ? cJSON_GetObjectItemCaseSensitive(params, "arguments") : NULL;

        if (!cJSON_IsString(name)) {
            cJSON *err = cJSON_CreateObject();
            cJSON_AddNumberToObject(err, "code", -32602);
            cJSON_AddStringToObject(err, "message", "tool name required");
            cJSON_AddItemToObject(result, "error", err);
            *out_result = result;
            return 0;
        }

        tool_name = name->valuestring;
        if (!permission_allowed(tool_name)) {
            cJSON *err2 = cJSON_CreateObject();
            cJSON_AddNumberToObject(err2, "code", -32603);
            cJSON_AddStringToObject(err2, "message", "permission_denied");
            cJSON_AddItemToObject(result, "error", err2);
            *out_result = result;
            return 0;
        }

        for (entry = g_tools; entry && entry->name != NULL; entry++) {
            if (strcmp(entry->name, tool_name) == 0) {
                cJSON *args_safe = args ? args : cJSON_CreateObject();
                tool_result = entry->fn(args_safe);
                if (!args) cJSON_Delete(args_safe);

                if (!tool_result) {
                    cJSON *err3 = cJSON_CreateObject();
                    cJSON_AddNumberToObject(err3, "code", -32603);
                    cJSON_AddStringToObject(err3, "message", "tool returned null");
                    cJSON_AddItemToObject(result, "error", err3);
                } else {
                    cJSON_AddItemToObject(result, "result", tool_result);
                }

                *out_result = result;
                return 0;
            }
        }

        {
            cJSON *err4 = cJSON_CreateObject();
            cJSON_AddNumberToObject(err4, "code", -32601);
            cJSON_AddStringToObject(err4, "message", "unknown_tool");
            cJSON_AddItemToObject(result, "error", err4);
            *out_result = result;
            return 0;
        }
    }

    {
        cJSON *err5 = cJSON_CreateObject();
        cJSON_AddNumberToObject(err5, "code", -32601);
        cJSON_AddStringToObject(err5, "message", "method_not_found");
        cJSON_AddItemToObject(result, "error", err5);
    }
    *out_result = result;
    return 0;
}

/* ── Pretty-print result ──────────────────────────────────────────────────── */

static void cli_print_result(cJSON *result)
{
    char *output;

    if (!result) return;

    /* Pretty-print JSON */
    output = cJSON_Print(result);
    if (output) {
        printf("%s\n", output);
        free(output);
    }
}

/* ── Main CLI entry point ─────────────────────────────────────────────────── */

int cli_mode_run(int argc, char *argv[])
{
    cJSON *req;
    cJSON *result;
    cJSON *error;
    cJSON *code;
    cJSON *msg;
    int exit_code = 0;
    WSADATA wsa_data;

    WSAStartup(MAKEWORD(2, 2), &wsa_data);

    /* Parse command from argv */
    req = cli_parse_command(argc, argv);
    if (!req) {
        WSACleanup();
        return 1;
    }

    /* Ensure local permission state is loaded for fallback mode. */
    permissions_load(PERMISSIONS_INI);

    /* Send and get response */
    if (cli_connect_and_send(req, &result) != 0) {
        fprintf(stderr, "Warning: IPC socket unavailable, running command locally.\n");
        if (cli_execute_local(req, &result) != 0) {
            cJSON_Delete(req);
            WSACleanup();
            return 1;
        }
    }

    cJSON_Delete(req);

    /* Check for error in response */
    error = cJSON_GetObjectItemCaseSensitive(result, "error");
    if (cJSON_IsObject(error)) {
        code = cJSON_GetObjectItemCaseSensitive(error, "code");
        msg = cJSON_GetObjectItemCaseSensitive(error, "message");
        fprintf(stderr, "Error: [%d] %s\n",
                cJSON_IsNumber(code) ? (int)code->valuedouble : -1,
                cJSON_IsString(msg) ? msg->valuestring : "unknown error");
        exit_code = 1;
    } else {
        /* Success: print result */
        cli_print_result(result);
    }

    cJSON_Delete(result);
    WSACleanup();
    return exit_code;
}
