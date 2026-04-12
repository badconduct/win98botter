/*
 * ipc_ops.h - Named pipe server for local IPC
 *
 * Allows local CLI commands and VB6 GUI to communicate with the MCP service
 * via named pipes (\\.\pipe\Win98MCPServer).
 *
 * The server runs in a background thread when the main service is active.
 */

#ifndef IPC_OPS_H
#define IPC_OPS_H

#include <windows.h>

typedef struct {
    HANDLE hPipe;
    char   buf[8192];
    int    buf_len;
} IPC_Client;

/* Start named pipe server in a background thread */
HANDLE ipc_server_start(void);

/* Stop the IPC server */
void ipc_server_stop(HANDLE hThread);

#endif /* IPC_OPS_H */
