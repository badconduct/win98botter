/*
 * config.h — Win98 MCP Server — compile-time constants
 *
 * All tuneable values live here. Change these before building.
 * No heap allocations for config — all values are compile-time constants
 * or read from permissions.ini at startup.
 */

#ifndef CONFIG_H
#define CONFIG_H

/* ── Relay connection ─────────────────────────────────────────────────────── */
#define DEFAULT_RELAY_HOST     "127.0.0.1"
#define DEFAULT_RELAY_PORT     9000
#define CONNECT_RETRY_COUNT    3
#define CONNECT_RETRY_DELAY_MS 2000

/* ── Local IPC ───────────────────────────────────────────────────────────── */
#define IPC_PORT               9421

/* ── TCP framing ─────────────────────────────────────────────────────────── */
/* Each JSON-RPC message is prefixed with a 4-byte big-endian uint32 length. */
#define MSG_LENGTH_PREFIX_BYTES 4
#define MAX_MESSAGE_BYTES       (16 * 1024 * 1024)   /* 16 MB hard limit     */
#define RECV_BUFFER_BYTES       (64 * 1024)           /* 64 KB recv scratch   */

/* ── File I/O ────────────────────────────────────────────────────────────── */
#define MAX_PATH_BYTES          512
#define READ_FILE_MAX_BYTES     (32 * 1024)           /* single read chunk    */
#define WRITE_FILE_MAX_BYTES    (64 * 1024)           /* content sanity cap   */
#define OUTPUT_CAPTURE_MAX_BYTES (64 * 1024)          /* pipe capture cap     */

/* ── Backup subsystem ────────────────────────────────────────────────────── */
#define BASE_DIR               "C:\\WIN98BOTTER"
#define BACKUP_DIR             "C:\\WIN98BOTTER\\BACKUPS"
#define HISTORY_LOG            "C:\\WIN98BOTTER\\history.log"
#define AGENT_LOG              "C:\\WIN98BOTTER\\agent.log"
#define PERMISSIONS_INI        "C:\\WIN98BOTTER\\permissions.ini"
#define TEMP_DIR               "C:\\WIN98BOTTER\\TEMP"

/* ── Command execution ───────────────────────────────────────────────────── */
#define DEFAULT_CMD_TIMEOUT_MS 30000
#define MAX_ASYNC_COMMANDS     8

/* ── Heartbeat ───────────────────────────────────────────────────────────── */
#define HEARTBEAT_INTERVAL_MS  60000

/* ── Versions ────────────────────────────────────────────────────────────── */
#define SERVER_NAME    "Win98MCPAgent"
/* Update SERVER_VERSION whenever shipping behavior or protocol changes. */
#define SERVER_VERSION "0.8"
#define MCP_PROTOCOL   "1.0"

/* ── WIN32 target ────────────────────────────────────────────────────────── */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0400    /* Windows 98 / NT4 target */
#endif

/* ── Legacy SDK compatibility (VC6/old headers) ────────────────────────── */
#ifndef INVALID_FILE_ATTRIBUTES
#define INVALID_FILE_ATTRIBUTES ((DWORD)-1)
#endif

#ifndef INVALID_SET_FILE_POINTER
#define INVALID_SET_FILE_POINTER ((DWORD)-1)
#endif

#ifndef DWORD_PTR
#define DWORD_PTR DWORD
#endif

#endif /* CONFIG_H */
