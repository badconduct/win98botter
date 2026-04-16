/*
 * file_ops.c — File operations for Win98 MCP agent
 *
 * Implements: read_file, write_file, write_file_binary, append_file,
 *             delete_file, copy_file, move_file, get_file_info,
 *             list_directory, grep_file, list_backups, restore_backup,
 *             get_history, file_exists
 *
 * Every destructive operation automatically backs up the original first.
 * Backup folder: C:\WIN98BOTTER\BACKUPS\<path_with_slashes_as_dirs>\<ts>.bak
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "file_ops.h"
#include "cJSON.h"

/* ── Binary file transfer open handles ──────────────────────────────────── */
#define MAX_BINARY_HANDLES 4

typedef struct {
    char   path[MAX_PATH_BYTES];
    HANDLE hFile;
    DWORD  total_size;
    int    in_use;
} BinaryTransfer;

static BinaryTransfer g_transfers[MAX_BINARY_HANDLES];

/* ── Internal helpers ─────────────────────────────────────────────────────── */

/* Replace all '/' with '\' in place */
static void normalise_path(char *p)
{
    while (*p) {
        if (*p == '/') *p = '\\';
        p++;
    }
}

/* Build timestamp string YYYYMMDD_HHMMSS */
static void make_timestamp(char *buf, size_t buf_size)
{
    SYSTEMTIME st;
    GetLocalTime(&st);
    _snprintf(buf, buf_size, "%04d%02d%02d_%02d%02d%02d",
              st.wYear, st.wMonth, st.wDay,
              st.wHour, st.wMinute, st.wSecond);
}

/* Return 1 if path looks like a temp file (no backup needed) */
static int is_temp_path(const char *path)
{
    /* Case-insensitive prefix checks */
    char upper[MAX_PATH_BYTES];
    int i;
    size_t len = strlen(path);
    if (len >= sizeof(upper)) return 0;
    for (i = 0; path[i]; i++) {
        upper[i] = (char)toupper((unsigned char)path[i]);
    }
    upper[i] = '\0';

    if (strstr(upper, "\\TEMP\\")    != NULL) return 1;
    if (strstr(upper, "\\WINDOWS\\TEMP") != NULL) return 1;
    if (len > 4 && _stricmp(upper + len - 4, ".TMP") == 0) return 1;
    return 0;
}

/*
 * Build backup path: BACKUP_DIR\<drive>\<dir>\<file>\<timestamp>.bak
 * Replaces ':' and '\' in the source path to build a directory tree.
 */
static int build_backup_path(const char *src, char *out, size_t out_size)
{
    char ts[32];
    char safe[MAX_PATH_BYTES];
    int i;
    size_t src_len = strlen(src);

    if (src_len >= sizeof(safe)) return 0;

    /* Convert path chars to safe dir names */
    for (i = 0; src[i]; i++) {
        if (src[i] == ':') {
            safe[i] = '_';
        } else if (src[i] == '\\') {
            safe[i] = '\\';
        } else {
            safe[i] = src[i];
        }
    }
    safe[i] = '\0';

    make_timestamp(ts, sizeof(ts));
    _snprintf(out, out_size, "%s\\%s\\%s.bak", BACKUP_DIR, safe, ts);
    return 1;
}

/* Recursively create directories for the given file path */
static void ensure_parent_dirs(const char *file_path)
{
    char dir[MAX_PATH_BYTES];
    char *p;
    size_t len = strlen(file_path);
    if (len >= sizeof(dir)) return;
    memcpy(dir, file_path, len + 1);

    /* Walk backwards to find the last backslash */
    p = dir + len;
    while (p > dir && *p != '\\') p--;
    if (p == dir) return;
    *p = '\0';

    /* Create each component */
    for (p = dir + 1; *p; p++) {
        if (*p == '\\') {
            *p = '\0';
            CreateDirectoryA(dir, NULL);
            *p = '\\';
        }
    }
    CreateDirectoryA(dir, NULL);
}

/*
 * backup_file — copies src to a backup path.
 * Returns 1 on success, 0 on failure or if src doesn't exist.
 * Writes backup path into out_backup_path if not NULL.
 */
static int backup_file(const char *src, char *out_backup_path, size_t bp_size)
{
    char bp[MAX_PATH * 2];

    if (is_temp_path(src)) {
        if (out_backup_path && bp_size > 0) out_backup_path[0] = '\0';
        return 1; /* skip backup for temp files — not an error */
    }

    if (GetFileAttributesA(src) == INVALID_FILE_ATTRIBUTES) {
        if (out_backup_path && bp_size > 0) out_backup_path[0] = '\0';
        return 1; /* file doesn't exist yet — nothing to back up */
    }

    if (!build_backup_path(src, bp, sizeof(bp))) return 0;

    ensure_parent_dirs(bp);

    if (!CopyFileA(src, bp, FALSE)) return 0;

    if (out_backup_path && bp_size > 0) {
        _snprintf(out_backup_path, bp_size, "%s", bp);
    }
    return 1;
}

/* Append one line to history.log */
static void history_append(const char *action, const char *path, const char *extra)
{
    FILE *f;
    SYSTEMTIME st;
    GetLocalTime(&st);
    f = fopen(HISTORY_LOG, "a");
    if (!f) return;
    fprintf(f, "%04d-%02d-%02d %02d:%02d:%02d | %-7s | %-60s | %s\n",
            st.wYear, st.wMonth, st.wDay,
            st.wHour, st.wMinute, st.wSecond,
            action, path, extra ? extra : "");
    fclose(f);
}

/* ── Base64 decoder (RFC 4648, no line wrapping) ──────────────────────────── */

static const signed char B64_TABLE[256] = {
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1, 0,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1
};

/* Decode Base64 into out. Returns decoded byte count, or -1 on error.      */
static int b64_decode(const char *in, unsigned char *out, int max_out)
{
    int olen = 0;
    int acc  = 0;
    int bits = 0;
    const char *p = in;

    while (*p) {
        unsigned char c = (unsigned char)*p++;
        signed char v = B64_TABLE[c];
        if (v < 0) continue; /* skip padding/whitespace */
        acc  = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (olen >= max_out) return -1;
            out[olen++] = (unsigned char)((acc >> bits) & 0xFF);
        }
    }
    return olen;
}

/* Base64 encoder */
static const char B64_CHARS[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int b64_encode(const unsigned char *in, int in_len, char *out, int max_out)
{
    int i;
    int olen = 0;
    for (i = 0; i < in_len; i += 3) {
        unsigned int b0 = (unsigned char)in[i];
        unsigned int b1 = (i+1 < in_len) ? (unsigned char)in[i+1] : 0;
        unsigned int b2 = (i+2 < in_len) ? (unsigned char)in[i+2] : 0;
        if (olen + 4 >= max_out) return -1;
        out[olen++] = B64_CHARS[(b0 >> 2) & 0x3F];
        out[olen++] = B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        out[olen++] = (i+1 < in_len) ? B64_CHARS[((b1 & 0xF) << 2) | (b2 >> 6)] : '=';
        out[olen++] = (i+2 < in_len) ? B64_CHARS[b2 & 0x3F] : '=';
    }
    if (max_out > olen) out[olen] = '\0';
    return olen;
}

/* ── Tool implementations ─────────────────────────────────────────────────── */

cJSON *tool_read_file(cJSON *params)
{
    const char *path_raw;
    char path[MAX_PATH_BYTES];
    cJSON *j_path, *j_offset, *j_length;
    HANDLE hFile;
    DWORD offset = 0, length = READ_FILE_MAX_BYTES;
    DWORD file_size, bytes_read;
    unsigned char *buf;
    char *b64;
    int b64_len;
    cJSON *result;

    j_path   = cJSON_GetObjectItemCaseSensitive(params, "path");
    j_offset = cJSON_GetObjectItemCaseSensitive(params, "offset");
    j_length = cJSON_GetObjectItemCaseSensitive(params, "length");

    if (!cJSON_IsString(j_path)) {
        return cJSON_CreateString("{\"error\":\"path required\"}");
    }

    path_raw = j_path->valuestring;
    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        return cJSON_CreateString("{\"error\":\"path too long\"}");
    }
    strcpy(path, path_raw);
    normalise_path(path);

    if (cJSON_IsNumber(j_offset)) offset = (DWORD)j_offset->valuedouble;
    if (cJSON_IsNumber(j_length)) {
        length = (DWORD)j_length->valuedouble;
        if (length > READ_FILE_MAX_BYTES) length = READ_FILE_MAX_BYTES;
    }

    hFile = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "cannot_open_file");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    file_size = GetFileSize(hFile, NULL);
    if (file_size == INVALID_FILE_SIZE) {
        CloseHandle(hFile);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "cannot_get_size");
        return result;
    }

    if (offset >= file_size) {
        CloseHandle(hFile);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "path", path);
        cJSON_AddNumberToObject(result, "offset", (double)offset);
        cJSON_AddNumberToObject(result, "length", 0.0);
        cJSON_AddNumberToObject(result, "total_size", (double)file_size);
        cJSON_AddStringToObject(result, "data_b64", "");
        cJSON_AddBoolToObject(result, "eof", 1);
        return result;
    }

    if (SetFilePointer(hFile, (LONG)offset, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) {
        CloseHandle(hFile);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "seek_failed");
        return result;
    }

    buf = (unsigned char *)malloc(length);
    if (!buf) { CloseHandle(hFile); return NULL; }

    ReadFile(hFile, buf, length, &bytes_read, NULL);
    CloseHandle(hFile);

    /* Base64 encode */
    b64_len = bytes_read * 4 / 3 + 8;
    b64 = (char *)malloc(b64_len);
    if (!b64) { free(buf); return NULL; }
    b64_encode(buf, (int)bytes_read, b64, b64_len);
    free(buf);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "path",       path);
    cJSON_AddNumberToObject(result, "offset",     (double)offset);
    cJSON_AddNumberToObject(result, "length",     (double)bytes_read);
    cJSON_AddNumberToObject(result, "total_size", (double)file_size);
    cJSON_AddStringToObject(result, "data_b64",   b64);
    cJSON_AddBoolToObject(result, "eof",
                          (offset + bytes_read >= file_size) ? 1 : 0);
    free(b64);
    return result;
}

cJSON *tool_write_file(cJSON *params)
{
    const char *path_raw, *content;
    char path[MAX_PATH_BYTES];
    char tmp_path[MAX_PATH_BYTES + 8];
    char backup_path[MAX_PATH * 2];
    cJSON *j_path, *j_content;
    HANDLE hFile;
    DWORD written;
    cJSON *result;

    j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    j_content = cJSON_GetObjectItemCaseSensitive(params, "content");

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_content)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path and content required");
        return result;
    }

    path_raw = j_path->valuestring;
    content  = j_content->valuestring;

    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    /* Backup original */
    backup_path[0] = '\0';
    backup_file(path, backup_path, sizeof(backup_path));

    /* Write to .tmp first */
    _snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", path);
    ensure_parent_dirs(path);

    hFile = CreateFileA(tmp_path, GENERIC_WRITE, 0, NULL,
                        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddStringToObject(result, "error", "cannot_create_tmp");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    WriteFile(hFile, content, (DWORD)strlen(content), &written, NULL);
    CloseHandle(hFile);

    /* Atomic rename: delete original, rename tmp → path */
    DeleteFileA(path);
    if (!MoveFileA(tmp_path, path)) {
        /* Rename failed — original is already in backup, tmp stays as evidence */
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddStringToObject(result, "error", "rename_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    history_append("WRITE", path, backup_path[0] ? backup_path : "(no backup)");

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddStringToObject(result, "path", path);
    cJSON_AddStringToObject(result, "backup_path", backup_path);
    cJSON_AddNumberToObject(result, "bytes_written", (double)written);
    return result;
}

cJSON *tool_write_file_binary(cJSON *params)
{
    const char *path_raw, *b64;
    char path[MAX_PATH_BYTES];
    cJSON *j_path, *j_b64, *j_offset, *j_total, *j_final;
    DWORD byte_offset = 0;
    unsigned char *decoded;
    int decoded_len;
    DWORD written;
    int i;
    int slot = -1;
    int is_final;
    cJSON *result;

    j_path   = cJSON_GetObjectItemCaseSensitive(params, "path");
    j_b64    = cJSON_GetObjectItemCaseSensitive(params, "b64_chunk");
    j_offset = cJSON_GetObjectItemCaseSensitive(params, "byte_offset");
    j_total  = cJSON_GetObjectItemCaseSensitive(params, "total_size");
    j_final  = cJSON_GetObjectItemCaseSensitive(params, "is_final");

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_b64)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path and b64_chunk required");
        return result;
    }

    path_raw = j_path->valuestring;
    b64      = j_b64->valuestring;

    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    if (cJSON_IsNumber(j_offset)) byte_offset = (DWORD)j_offset->valuedouble;
    is_final = cJSON_IsBool(j_final) && j_final->type != cJSON_False;

    /* Find existing slot or allocate new one */
    for (i = 0; i < MAX_BINARY_HANDLES; i++) {
        if (g_transfers[i].in_use && _stricmp(g_transfers[i].path, path) == 0) {
            slot = i;
            break;
        }
    }
    if (slot < 0 && byte_offset == 0) {
        /* First chunk — open new slot */
        for (i = 0; i < MAX_BINARY_HANDLES; i++) {
            if (!g_transfers[i].in_use) { slot = i; break; }
        }
        if (slot < 0) {
            result = cJSON_CreateObject();
            cJSON_AddStringToObject(result, "error", "too_many_transfers");
            return result;
        }
        ensure_parent_dirs(path);
        g_transfers[slot].hFile = CreateFileA(path, GENERIC_WRITE, 0, NULL,
                                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (g_transfers[slot].hFile == INVALID_HANDLE_VALUE) {
            result = cJSON_CreateObject();
            cJSON_AddStringToObject(result, "error", "cannot_create_file");
            return result;
        }
        strcpy(g_transfers[slot].path, path);
        g_transfers[slot].in_use = 1;
        if (cJSON_IsNumber(j_total)) {
            g_transfers[slot].total_size = (DWORD)j_total->valuedouble;
        }
    }
    if (slot < 0) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "no_open_transfer");
        return result;
    }

    /* Decode and write */
    decoded_len = (int)((strlen(b64) * 3) / 4 + 4);
    decoded = (unsigned char *)malloc(decoded_len);
    if (!decoded) return NULL;
    decoded_len = b64_decode(b64, decoded, decoded_len);
    if (decoded_len < 0) {
        free(decoded);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "b64_decode_failed");
        return result;
    }

    if (g_transfers[slot].hFile != INVALID_HANDLE_VALUE) {
        SetFilePointer(g_transfers[slot].hFile, (LONG)byte_offset, NULL, FILE_BEGIN);
        WriteFile(g_transfers[slot].hFile, decoded, (DWORD)decoded_len, &written, NULL);
    } else {
        written = 0;
    }
    free(decoded);

    if (is_final) {
        CloseHandle(g_transfers[slot].hFile);
        g_transfers[slot].hFile  = INVALID_HANDLE_VALUE;
        g_transfers[slot].in_use = 0;
        history_append("WRITE_BIN", path, "binary transfer complete");
    }

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddNumberToObject(result, "bytes_written", (double)written);
    cJSON_AddBoolToObject(result, "is_final", is_final);
    return result;
}

cJSON *tool_append_file(cJSON *params)
{
    const char *path_raw, *content;
    char path[MAX_PATH_BYTES];
    cJSON *j_path, *j_content;
    HANDLE hFile;
    DWORD written;
    cJSON *result;

    j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    j_content = cJSON_GetObjectItemCaseSensitive(params, "content");

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_content)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path and content required");
        return result;
    }

    path_raw = j_path->valuestring;
    content  = j_content->valuestring;
    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    ensure_parent_dirs(path);
    hFile = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddStringToObject(result, "error", "cannot_open");
        return result;
    }
    WriteFile(hFile, content, (DWORD)strlen(content), &written, NULL);
    CloseHandle(hFile);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddNumberToObject(result, "bytes_written", (double)written);
    return result;
}

cJSON *tool_delete_file(cJSON *params)
{
    const char *path_raw;
    char path[MAX_PATH_BYTES];
    char backup_path[MAX_PATH * 2];
    cJSON *j_path;
    cJSON *result;

    j_path = cJSON_GetObjectItemCaseSensitive(params, "path");
    if (!cJSON_IsString(j_path)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path required");
        return result;
    }

    path_raw = j_path->valuestring;
    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    backup_path[0] = '\0';
    backup_file(path, backup_path, sizeof(backup_path));

    if (!DeleteFileA(path)) {
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    history_append("DELETE", path, backup_path[0] ? backup_path : "(no backup)");

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddStringToObject(result, "backup_path", backup_path);
    return result;
}

cJSON *tool_copy_file(cJSON *params)
{
    const char *src_raw, *dst_raw;
    char src[MAX_PATH_BYTES], dst[MAX_PATH_BYTES];
    cJSON *j_src, *j_dst;
    cJSON *result;

    j_src = cJSON_GetObjectItemCaseSensitive(params, "src");
    j_dst = cJSON_GetObjectItemCaseSensitive(params, "dst");

    if (!cJSON_IsString(j_src) || !cJSON_IsString(j_dst)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "src and dst required");
        return result;
    }

    src_raw = j_src->valuestring;
    dst_raw = j_dst->valuestring;
    if (strlen(src_raw) >= MAX_PATH_BYTES || strlen(dst_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(src, src_raw); normalise_path(src);
    strcpy(dst, dst_raw); normalise_path(dst);

    ensure_parent_dirs(dst);

    if (!CopyFileA(src, dst, FALSE)) {
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    return result;
}

cJSON *tool_move_file(cJSON *params)
{
    const char *src_raw, *dst_raw;
    char src[MAX_PATH_BYTES], dst[MAX_PATH_BYTES];
    char backup_path[MAX_PATH * 2];
    cJSON *j_src, *j_dst;
    cJSON *result;

    j_src = cJSON_GetObjectItemCaseSensitive(params, "src");
    j_dst = cJSON_GetObjectItemCaseSensitive(params, "dst");

    if (!cJSON_IsString(j_src) || !cJSON_IsString(j_dst)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "src and dst required");
        return result;
    }

    src_raw = j_src->valuestring;
    dst_raw = j_dst->valuestring;
    if (strlen(src_raw) >= MAX_PATH_BYTES || strlen(dst_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(src, src_raw); normalise_path(src);
    strcpy(dst, dst_raw); normalise_path(dst);

    backup_path[0] = '\0';
    backup_file(src, backup_path, sizeof(backup_path));
    ensure_parent_dirs(dst);

    if (!MoveFileA(src, dst)) {
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    history_append("MOVE", src, dst);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddStringToObject(result, "backup_path", backup_path);
    return result;
}

cJSON *tool_get_file_info(cJSON *params)
{
    cJSON *j_path;
    const char *path_raw;
    char path[MAX_PATH_BYTES];
    WIN32_FILE_ATTRIBUTE_DATA fad;
    SYSTEMTIME st;
    char date_buf[32];
    DWORD attr;
    cJSON *result;
    LARGE_INTEGER sz;

    j_path = cJSON_GetObjectItemCaseSensitive(params, "path");
    if (!cJSON_IsString(j_path)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path required");
        return result;
    }

    path_raw = j_path->valuestring;
    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    attr = GetFileAttributesA(path);
    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "path", path);

    if (attr == INVALID_FILE_ATTRIBUTES) {
        cJSON_AddBoolToObject(result, "exists", 0);
        return result;
    }

    cJSON_AddBoolToObject(result, "exists", 1);
    cJSON_AddBoolToObject(result, "is_directory", (attr & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0);

    /* Get size and dates */
    if (GetFileAttributesExA(path, GetFileExInfoStandard, &fad)) {
        sz.LowPart  = fad.nFileSizeLow;
        sz.HighPart = (LONG)fad.nFileSizeHigh;
        cJSON_AddNumberToObject(result, "size_bytes", (double)sz.QuadPart);

        FileTimeToSystemTime(&fad.ftLastWriteTime, &st);
        _snprintf(date_buf, sizeof(date_buf), "%04d-%02d-%02d %02d:%02d:%02d",
                  st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
        cJSON_AddStringToObject(result, "modified", date_buf);

        FileTimeToSystemTime(&fad.ftCreationTime, &st);
        _snprintf(date_buf, sizeof(date_buf), "%04d-%02d-%02d %02d:%02d:%02d",
                  st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
        cJSON_AddStringToObject(result, "created", date_buf);
    }

    /* Attributes string */
    {
        char attrbuf[8];
        int ai = 0;
        if (attr & FILE_ATTRIBUTE_READONLY)  attrbuf[ai++] = 'R';
        if (attr & FILE_ATTRIBUTE_HIDDEN)    attrbuf[ai++] = 'H';
        if (attr & FILE_ATTRIBUTE_SYSTEM)    attrbuf[ai++] = 'S';
        if (attr & FILE_ATTRIBUTE_ARCHIVE)   attrbuf[ai++] = 'A';
        if (attr & FILE_ATTRIBUTE_DIRECTORY) attrbuf[ai++] = 'D';
        attrbuf[ai] = '\0';
        cJSON_AddStringToObject(result, "attributes", attrbuf);
    }

    return result;
}

cJSON *tool_list_directory(cJSON *params)
{
    cJSON *j_path, *j_pattern, *j_recursive;
    const char *path_raw;
    char path[MAX_PATH_BYTES];
    char search_path[MAX_PATH_BYTES + 8];
    WIN32_FIND_DATAA ffd;
    HANDLE hFind;
    SYSTEMTIME st;
    char date_buf[32];
    cJSON *result, *entries, *entry;
    LARGE_INTEGER sz;

    j_path      = cJSON_GetObjectItemCaseSensitive(params, "path");
    j_pattern   = cJSON_GetObjectItemCaseSensitive(params, "pattern");
    j_recursive = cJSON_GetObjectItemCaseSensitive(params, "recursive");
    (void)j_recursive; /* recursive listing not yet implemented */

    if (!cJSON_IsString(j_path)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path required");
        return result;
    }

    path_raw = j_path->valuestring;
    if (strlen(path_raw) >= MAX_PATH_BYTES - 4) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    /* Build search glob */
    {
        const char *pattern = (cJSON_IsString(j_pattern)) ? j_pattern->valuestring : "*.*";
        _snprintf(search_path, sizeof(search_path), "%s\\%s", path, pattern);
    }

    entries = cJSON_CreateArray();
    hFind = FindFirstFileA(search_path, &ffd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (strcmp(ffd.cFileName, ".") == 0 || strcmp(ffd.cFileName, "..") == 0)
                continue;

            entry = cJSON_CreateObject();
            cJSON_AddStringToObject(entry, "name", ffd.cFileName);
            cJSON_AddStringToObject(entry, "type",
                (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? "dir" : "file");

            sz.LowPart  = ffd.nFileSizeLow;
            sz.HighPart = (LONG)ffd.nFileSizeHigh;
            cJSON_AddNumberToObject(entry, "size", (double)sz.QuadPart);

            FileTimeToSystemTime(&ffd.ftLastWriteTime, &st);
            _snprintf(date_buf, sizeof(date_buf), "%04d-%02d-%02d %02d:%02d:%02d",
                      st.wYear, st.wMonth, st.wDay,
                      st.wHour, st.wMinute, st.wSecond);
            cJSON_AddStringToObject(entry, "modified", date_buf);

            cJSON_AddItemToArray(entries, entry);
        } while (FindNextFileA(hFind, &ffd));
        FindClose(hFind);
    }

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "path", path);
    cJSON_AddItemToObject(result, "entries", entries);
    cJSON_AddNumberToObject(result, "count", (double)cJSON_GetArraySize(entries));
    return result;
}

cJSON *tool_grep_file(cJSON *params)
{
    cJSON *j_path, *j_pattern, *j_max;
    const char *path_raw, *search_pattern;
    char path[MAX_PATH_BYTES];
    FILE *f;
    char line_buf[4096];
    int line_num = 0;
    int match_count = 0;
    int max_results = 100;
    cJSON *result, *matches, *match;

    j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    j_pattern = cJSON_GetObjectItemCaseSensitive(params, "pattern");
    j_max     = cJSON_GetObjectItemCaseSensitive(params, "max_results");

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_pattern)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path and pattern required");
        return result;
    }

    path_raw       = j_path->valuestring;
    search_pattern = j_pattern->valuestring;

    if (strlen(path_raw) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, path_raw);
    normalise_path(path);

    if (cJSON_IsNumber(j_max)) max_results = (int)j_max->valuedouble;

    f = fopen(path, "r");
    if (!f) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "cannot_open");
        return result;
    }

    matches = cJSON_CreateArray();
    while (fgets(line_buf, sizeof(line_buf), f) && match_count < max_results) {
        line_num++;
        /* Case-insensitive substring search */
        {
            /* Simple: convert both to upper inline. */
            char upper_line[4096];
            char upper_pat[512];
            int i;
            size_t pat_len = strlen(search_pattern);

            if (pat_len < sizeof(upper_pat)) {
                for (i = 0; search_pattern[i]; i++)
                    upper_pat[i] = (char)toupper((unsigned char)search_pattern[i]);
                upper_pat[i] = '\0';

                for (i = 0; line_buf[i]; i++)
                    upper_line[i] = (char)toupper((unsigned char)line_buf[i]);
                upper_line[i] = '\0';

                if (strstr(upper_line, upper_pat) != NULL) {
                    /* Strip trailing newline */
                    char trimmed[4096];
                    int end;
                    strcpy(trimmed, line_buf);
                    end = (int)strlen(trimmed) - 1;
                    while (end >= 0 && (trimmed[end] == '\r' || trimmed[end] == '\n'))
                        trimmed[end--] = '\0';

                    match = cJSON_CreateObject();
                    cJSON_AddNumberToObject(match, "line",    (double)line_num);
                    cJSON_AddStringToObject(match, "content", trimmed);
                    cJSON_AddItemToArray(matches, match);
                    match_count++;
                }
            }
        }
    }
    fclose(f);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "path", path);
    cJSON_AddStringToObject(result, "pattern", search_pattern);
    cJSON_AddItemToObject(result, "matches", matches);
    cJSON_AddNumberToObject(result, "match_count", (double)match_count);
    return result;
}

cJSON *tool_get_history(cJSON *params)
{
    FILE *f;
    char line_buf[1024];
    int limit = 50;
    cJSON *j_limit = cJSON_GetObjectItemCaseSensitive(params, "limit");
    cJSON *entries, *result;

    if (cJSON_IsNumber(j_limit)) limit = (int)j_limit->valuedouble;

    entries = cJSON_CreateArray();

    f = fopen(HISTORY_LOG, "r");
    if (f) {
        /* Collect all lines, return the last 'limit' lines */
        char lines[200][1024];
        int total = 0;
        int i;
        while (fgets(line_buf, sizeof(line_buf), f) && total < 200) {
            int end = (int)strlen(line_buf) - 1;
            while (end >= 0 && (line_buf[end] == '\r' || line_buf[end] == '\n'))
                line_buf[end--] = '\0';
            strcpy(lines[total], line_buf);
            total++;
        }
        fclose(f);

        for (i = (total > limit ? total - limit : 0); i < total; i++) {
            cJSON_AddItemToArray(entries, cJSON_CreateString(lines[i]));
        }
    }

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "entries", entries);
    cJSON_AddNumberToObject(result, "count", (double)cJSON_GetArraySize(entries));
    return result;
}

cJSON *tool_file_exists(cJSON *params)
{
    cJSON *j_path = cJSON_GetObjectItemCaseSensitive(params, "path");
    char path[MAX_PATH_BYTES];
    cJSON *result;

    if (!cJSON_IsString(j_path)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path required");
        return result;
    }
    if (strlen(j_path->valuestring) >= MAX_PATH_BYTES) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path too long");
        return result;
    }
    strcpy(path, j_path->valuestring);
    normalise_path(path);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "exists",
        (GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES) ? 1 : 0);
    return result;
}
