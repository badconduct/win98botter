/*
 * ini_ops.c — INI file read/write for Win98 MCP agent
 *
 * Implements: ini_read, ini_read_section, ini_list_sections,
 *             ini_write, ini_delete_key
 *
 * Uses GetPrivateProfileString / WritePrivateProfileString (Win32 API).
 * These are native to Win98SE and handle all the edge cases.
 *
 * ini_write also backs up the file via the safe-write subsystem before
 * any modification and returns the previous value for audit purposes.
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "ini_ops.h"
#include "cJSON.h"

/* ── Internal helper: backup before INI write ──────────────────────────── */
/* (Duplicated from file_ops to keep ini_ops.c self-contained.)            */

static void ini_backup(const char *ini_path)
{
    char backup_dir[MAX_PATH_BYTES * 2];
    char ts[32];
    SYSTEMTIME st;
    char safe[MAX_PATH_BYTES];
    int i;
    size_t len;

    GetLocalTime(&st);
    _snprintf(ts, sizeof(ts), "%04d%02d%02d_%02d%02d%02d",
              st.wYear, st.wMonth, st.wDay,
              st.wHour, st.wMinute, st.wSecond);

    len = strlen(ini_path);
    if (len >= sizeof(safe)) return;
    for (i = 0; ini_path[i]; i++) {
        safe[i] = (ini_path[i] == ':') ? '_' : ini_path[i];
    }
    safe[i] = '\0';

    _snprintf(backup_dir, sizeof(backup_dir), "%s\\%s", BACKUP_DIR, safe);

    /* mkdir recursively (simplified — only one level needed past BACKUP_DIR) */
    {
        char tmp[MAX_PATH_BYTES * 2];
        char *p;
        strcpy(tmp, backup_dir);
        for (p = tmp + strlen(BACKUP_DIR) + 1; *p; p++) {
            if (*p == '\\') {
                *p = '\0';
                CreateDirectoryA(tmp, NULL);
                *p = '\\';
            }
        }
        CreateDirectoryA(tmp, NULL);
    }

    {
        char bp[MAX_PATH_BYTES * 2 + 40];
        _snprintf(bp, sizeof(bp), "%s\\%s.bak", backup_dir, ts);
        CopyFileA(ini_path, bp, FALSE);
    }
}

/* ── Tool implementations ─────────────────────────────────────────────────── */

cJSON *tool_ini_read(cJSON *params)
{
    cJSON *j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    cJSON *j_section = cJSON_GetObjectItemCaseSensitive(params, "section");
    cJSON *j_key     = cJSON_GetObjectItemCaseSensitive(params, "key");
    char value[4096];
    DWORD n;
    cJSON *result;

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_section) || !cJSON_IsString(j_key)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path, section, key required");
        return result;
    }

    n = GetPrivateProfileStringA(
        j_section->valuestring,
        j_key->valuestring,
        "\x01",          /* sentinel: value not found */
        value, sizeof(value),
        j_path->valuestring);

    result = cJSON_CreateObject();
    if (n == 1 && value[0] == '\x01') {
        cJSON_AddStringToObject(result, "value",     "");
        cJSON_AddBoolToObject(result, "not_found", 1);
    } else {
        cJSON_AddStringToObject(result, "value",     value);
        cJSON_AddBoolToObject(result, "not_found", 0);
    }
    return result;
}

cJSON *tool_ini_read_section(cJSON *params)
{
    cJSON *j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    cJSON *j_section = cJSON_GetObjectItemCaseSensitive(params, "section");
    char *buf;
    int buf_size = 32768;
    DWORD n;
    cJSON *result, *keys_obj;
    const char *p;

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_section)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path and section required");
        return result;
    }

    buf = (char *)malloc(buf_size);
    if (!buf) return NULL;

    /* GetPrivateProfileSection returns double-null-terminated list of "key=value\0" strings */
    n = GetPrivateProfileSectionA(
        j_section->valuestring,
        buf, buf_size,
        j_path->valuestring);

    keys_obj = cJSON_CreateObject();
    p = buf;
    while (p < buf + n && *p) {
        char key[512], val[2048];
        const char *eq = strchr(p, '=');
        if (eq) {
            size_t klen = (size_t)(eq - p);
            size_t vlen = strlen(eq + 1);
            if (klen < sizeof(key) && vlen < sizeof(val)) {
                memcpy(key, p, klen); key[klen] = '\0';
                strcpy(val, eq + 1);
                cJSON_AddStringToObject(keys_obj, key, val);
            }
        }
        p += strlen(p) + 1;
    }
    free(buf);

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "keys", keys_obj);
    cJSON_AddNumberToObject(result, "count", (double)cJSON_GetArraySize(keys_obj));
    return result;
}

cJSON *tool_ini_list_sections(cJSON *params)
{
    cJSON *j_path = cJSON_GetObjectItemCaseSensitive(params, "path");
    char *buf;
    int buf_size = 32768;
    DWORD n;
    cJSON *result, *sections;
    const char *p;

    if (!cJSON_IsString(j_path)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path required");
        return result;
    }

    buf = (char *)malloc(buf_size);
    if (!buf) return NULL;

    /* Passing NULL for section name returns list of section names */
    n = GetPrivateProfileSectionNamesA(buf, buf_size, j_path->valuestring);

    sections = cJSON_CreateArray();
    p = buf;
    while (p < buf + n && *p) {
        cJSON_AddItemToArray(sections, cJSON_CreateString(p));
        p += strlen(p) + 1;
    }
    free(buf);

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "sections", sections);
    return result;
}

cJSON *tool_ini_write(cJSON *params)
{
    cJSON *j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    cJSON *j_section = cJSON_GetObjectItemCaseSensitive(params, "section");
    cJSON *j_key     = cJSON_GetObjectItemCaseSensitive(params, "key");
    cJSON *j_value   = cJSON_GetObjectItemCaseSensitive(params, "value");
    char prev_value[4096];
    BOOL ok;
    cJSON *result;

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_section) ||
        !cJSON_IsString(j_key)  || !cJSON_IsString(j_value)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path, section, key, value required");
        return result;
    }

    /* Read previous value first (for audit) */
    GetPrivateProfileStringA(
        j_section->valuestring,
        j_key->valuestring,
        "", prev_value, sizeof(prev_value),
        j_path->valuestring);

    /* Backup before modifying */
    ini_backup(j_path->valuestring);

    ok = WritePrivateProfileStringA(
        j_section->valuestring,
        j_key->valuestring,
        j_value->valuestring,
        j_path->valuestring);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success",        ok ? 1 : 0);
    cJSON_AddStringToObject(result, "previous_value", prev_value);
    if (!ok) {
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
    }
    return result;
}

cJSON *tool_ini_delete_key(cJSON *params)
{
    cJSON *j_path    = cJSON_GetObjectItemCaseSensitive(params, "path");
    cJSON *j_section = cJSON_GetObjectItemCaseSensitive(params, "section");
    cJSON *j_key     = cJSON_GetObjectItemCaseSensitive(params, "key");
    BOOL ok;
    cJSON *result;

    if (!cJSON_IsString(j_path) || !cJSON_IsString(j_section) || !cJSON_IsString(j_key)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path, section, key required");
        return result;
    }

    ini_backup(j_path->valuestring);

    /* Passing NULL value deletes the key */
    ok = WritePrivateProfileStringA(
        j_section->valuestring,
        j_key->valuestring,
        NULL,
        j_path->valuestring);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", ok ? 1 : 0);
    if (!ok)
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
    return result;
}
