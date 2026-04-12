/*
 * cli_mode.c - Command-line interface for the MCP server
 *
 * Connects to the named pipe and sends a JSON-RPC request.
 * Maps simple command syntax to JSON-RPC format.
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

#define IPC_PIPE_NAME   "\\\\.\\pipe\\Win98MCPServer"

/* Forward declarations */
static int  cli_connect_and_send(cJSON *req, cJSON **out_result);
static void cli_print_result(cJSON *result);
static cJSON *cli_parse_command(int argc, char *argv[]);

/* ── Framing (same as TCP/IPC) ────────────────────────────────────────────── */

static int cli_send_msg(HANDLE hPipe, cJSON *msg)
{
    char *json_str;
    DWORD len;
    unsigned char hdr[4];
    DWORD written;

    json_str = cJSON_PrintUnformatted(msg);
    if (!json_str) return -1;

    len = (DWORD)strlen(json_str);

    /* 4-byte big-endian length prefix */
    hdr[0] = (unsigned char)((len >> 24) & 0xFF);
    hdr[1] = (unsigned char)((len >> 16) & 0xFF);
    hdr[2] = (unsigned char)((len >>  8) & 0xFF);
    hdr[3] = (unsigned char)((len      ) & 0xFF);

    if (!WriteFile(hPipe, hdr, 4, &written, NULL) || written != 4) {
        free(json_str);
        return -1;
    }

    if (!WriteFile(hPipe, json_str, len, &written, NULL) || written != len) {
        free(json_str);
        return -1;
    }

    free(json_str);
    return 0;
}

static int cli_recv_msg(HANDLE hPipe, char **out_buf, int *out_len)
{
    unsigned char hdr[4];
    DWORD msg_len;
    DWORD read;
    char *buf;
    DWORD total;

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

    if (msg_len > 1000000) return -1;

    buf = (char *)malloc(msg_len + 1);
    if (!buf) return -1;

    total = 0;
    while (total < msg_len) {
        if (!ReadFile(hPipe, buf + total, msg_len - total, &read, NULL) || read == 0) {
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
        cJSON *params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "read_file");
        cJSON *args = cJSON_CreateObject();
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
        cJSON *params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "write_file");
        cJSON *args = cJSON_CreateObject();
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
        cJSON *params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "run_command");
        cJSON *args = cJSON_CreateObject();
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
        cJSON *params = cJSON_CreateObject();
        cJSON_AddStringToObject(params, "name", "list_processes");
        cJSON *args = cJSON_CreateObject();
        cJSON_AddItemToObject(params, "arguments", args);
        cJSON_AddItemToObject(req, "params", params);
        return req;
    }

    /* Generic: treat as method with remaining args as JSON params */
    if (argc >= 3 && argv[2][0] == '{') {
        req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "jsonrpc", "2.0");
        cJSON_AddNumberToObject(req, "id", 1);
        cJSON_AddStringToObject(req, "method", argv[1]);
        cJSON_AddItemToObject(req, "params", cJSON_Parse(argv[2]));
        return req;
    }

    fprintf(stderr, "Unknown command: %s\n", argv[1]);
    return NULL;
}

/* ── Connect and send ─────────────────────────────────────────────────────── */

static int cli_connect_and_send(cJSON *req, cJSON **out_result)
{
    HANDLE hPipe;
    char *buf;
    int buf_len;
    cJSON *result;
    int retries = 3;

    if (!req || !out_result) return -1;

    /* Try to connect to the pipe (may not be ready yet) */
    while (retries > 0) {
        hPipe = CreateFileA(
            IPC_PIPE_NAME,
            GENERIC_READ | GENERIC_WRITE,
            0,
            NULL,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            NULL
        );

        if (hPipe != INVALID_HANDLE_VALUE) break;

        if (GetLastError() == ERROR_PIPE_BUSY) {
            WaitNamedPipeA(IPC_PIPE_NAME, 1000);
        }
        retries--;
        if (retries > 0) Sleep(500);
    }

    if (hPipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "Error: MCP Server not running (pipe not found)\n");
        return -1;
    }

    /* Send request */
    if (cli_send_msg(hPipe, req) != 0) {
        fprintf(stderr, "Error: Failed to send request\n");
        CloseHandle(hPipe);
        return -1;
    }

    /* Receive response */
    if (cli_recv_msg(hPipe, &buf, &buf_len) != 0) {
        fprintf(stderr, "Error: Failed to receive response\n");
        CloseHandle(hPipe);
        return -1;
    }

    CloseHandle(hPipe);

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
    int exit_code = 0;

    /* Parse command from argv */
    req = cli_parse_command(argc, argv);
    if (!req) return 1;

    /* Send and get response */
    if (cli_connect_and_send(req, &result) != 0) {
        cJSON_Delete(req);
        return 1;
    }

    cJSON_Delete(req);

    /* Check for error in response */
    error = cJSON_GetObjectItemCaseSensitive(result, "error");
    if (cJSON_IsObject(error)) {
        cJSON *code = cJSON_GetObjectItemCaseSensitive(error, "code");
        cJSON *msg = cJSON_GetObjectItemCaseSensitive(error, "message");
        fprintf(stderr, "Error: [%d] %s\n",
                cJSON_IsNumber(code) ? (int)code->valuedouble : -1,
                cJSON_IsString(msg) ? msg->valuestring : "unknown error");
        exit_code = 1;
    } else {
        /* Success: print result */
        cli_print_result(result);
    }

    cJSON_Delete(result);
    return exit_code;
}
