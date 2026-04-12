/*
 * cli_mode.h - Command-line interface for the MCP server
 *
 * Allows issuing commands to the MCP service via command-line.
 * Connects to the IPC named pipe and sends a request.
 */

#ifndef CLI_MODE_H
#define CLI_MODE_H

/* Run in CLI mode: connect to pipe, send command, get result */
int cli_mode_run(int argc, char *argv[]);

#endif /* CLI_MODE_H */
