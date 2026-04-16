/*
 * ipc_ops.h - Local TCP server for local IPC
 *
 * Allows local CLI commands and VB6 GUI to communicate with the MCP service
 * via local sockets (127.0.0.1:IPC_PORT).
 *
 * The server runs in a background thread when the main service is active.
 */

#ifndef IPC_OPS_H
#define IPC_OPS_H

#include <windows.h>
#include <winsock.h>

/* Start TCP server in a background thread */
HANDLE ipc_server_start(void);

/* Stop the IPC server */
void ipc_server_stop(HANDLE hThread);

#endif /* IPC_OPS_H */
