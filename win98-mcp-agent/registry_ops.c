/*
 * registry_ops.c — Registry operations for Win98 MCP agent
 *
 * Implements: read_registry, write_registry, delete_registry, list_registry
 *
 * Hive names accepted: HKLM, HKCU, HKCR, HKU, HKCC
 * (full names also accepted: HKEY_LOCAL_MACHINE, etc.)
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#include <windows.h>
#include <winreg.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "registry_ops.h"
#include "cJSON.h"

/* ── Hive name → handle mapping ──────────────────────────────────────────── */

static HKEY parse_hive(const char *name)
{
    if (_stricmp(name, "HKLM") == 0 ||
        _stricmp(name, "HKEY_LOCAL_MACHINE") == 0)  return HKEY_LOCAL_MACHINE;
    if (_stricmp(name, "HKCU") == 0 ||
        _stricmp(name, "HKEY_CURRENT_USER") == 0)   return HKEY_CURRENT_USER;
    if (_stricmp(name, "HKCR") == 0 ||
        _stricmp(name, "HKEY_CLASSES_ROOT") == 0)   return HKEY_CLASSES_ROOT;
    if (_stricmp(name, "HKU") == 0 ||
        _stricmp(name, "HKEY_USERS") == 0)          return HKEY_USERS;
    if (_stricmp(name, "HKCC") == 0 ||
        _stricmp(name, "HKEY_CURRENT_CONFIG") == 0) return HKEY_CURRENT_CONFIG;
    return NULL;
}

/* REG type name */
static const char *reg_type_name(DWORD type)
{
    switch (type) {
        case REG_SZ:                return "REG_SZ";
        case REG_EXPAND_SZ:         return "REG_EXPAND_SZ";
        case REG_BINARY:            return "REG_BINARY";
        case REG_DWORD:             return "REG_DWORD";
        case REG_DWORD_BIG_ENDIAN:  return "REG_DWORD_BE";
        case REG_MULTI_SZ:          return "REG_MULTI_SZ";
#ifdef REG_QWORD
        case REG_QWORD:             return "REG_QWORD";
#endif
        default:                    return "UNKNOWN";
    }
}

/* ── Tool implementations ─────────────────────────────────────────────────── */

cJSON *tool_read_registry(cJSON *params)
{
    cJSON *j_hive  = cJSON_GetObjectItemCaseSensitive(params, "hive");
    cJSON *j_key   = cJSON_GetObjectItemCaseSensitive(params, "key");
    cJSON *j_value = cJSON_GetObjectItemCaseSensitive(params, "value_name");
    HKEY hive, hKey;
    LONG err;
    DWORD type, data_size;
    BYTE *data;
    cJSON *result;
    const char *value_name;

    if (!cJSON_IsString(j_hive) || !cJSON_IsString(j_key)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "hive and key required");
        return result;
    }

    hive = parse_hive(j_hive->valuestring);
    if (!hive) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "unknown_hive");
        return result;
    }

    value_name = cJSON_IsString(j_value) ? j_value->valuestring : NULL;

    err = RegOpenKeyExA(hive, j_key->valuestring, 0, KEY_READ, &hKey);
    if (err != ERROR_SUCCESS) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error",    "key_not_found");
        cJSON_AddNumberToObject(result, "win32_error", (double)err);
        return result;
    }

    data_size = 0;
    err = RegQueryValueExA(hKey, value_name, NULL, &type, NULL, &data_size);
    if (err != ERROR_SUCCESS && err != ERROR_MORE_DATA) {
        RegCloseKey(hKey);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "value_not_found");
        return result;
    }

    data = (BYTE *)malloc(data_size + 2);
    if (!data) { RegCloseKey(hKey); return NULL; }
    data[data_size] = '\0'; data[data_size + 1] = '\0';

    err = RegQueryValueExA(hKey, value_name, NULL, &type, data, &data_size);
    RegCloseKey(hKey);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "type", reg_type_name(type));

    if (type == REG_SZ || type == REG_EXPAND_SZ) {
        cJSON_AddStringToObject(result, "data", (const char *)data);
    } else if (type == REG_DWORD) {
        cJSON_AddNumberToObject(result, "data", (double)(*(DWORD *)data));
    } else if (type == REG_MULTI_SZ) {
        /* Return as array of strings */
        cJSON *arr = cJSON_CreateArray();
        const char *p = (const char *)data;
        while (*p) {
            cJSON_AddItemToArray(arr, cJSON_CreateString(p));
            p += strlen(p) + 1;
        }
        cJSON_AddItemToObject(result, "data", arr);
    } else {
        /* Binary: hex string */
        char *hex = (char *)malloc(data_size * 3 + 1);
        if (hex) {
            DWORD i;
            hex[0] = '\0';
            for (i = 0; i < data_size; i++) {
                char byte_str[4];
                _snprintf(byte_str, sizeof(byte_str), "%02X ", data[i]);
                strcat(hex, byte_str);
            }
            cJSON_AddStringToObject(result, "data", hex);
            free(hex);
        }
    }

    free(data);
    return result;
}

cJSON *tool_write_registry(cJSON *params)
{
    cJSON *j_hive  = cJSON_GetObjectItemCaseSensitive(params, "hive");
    cJSON *j_key   = cJSON_GetObjectItemCaseSensitive(params, "key");
    cJSON *j_vname = cJSON_GetObjectItemCaseSensitive(params, "value_name");
    cJSON *j_data  = cJSON_GetObjectItemCaseSensitive(params, "data");
    cJSON *j_type  = cJSON_GetObjectItemCaseSensitive(params, "type");
    HKEY hive, hKey;
    LONG err;
    DWORD disp;
    const char *type_str;
    DWORD reg_type = REG_SZ;
    cJSON *result;

    if (!cJSON_IsString(j_hive) || !cJSON_IsString(j_key) ||
        !cJSON_IsString(j_vname) || !j_data) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "hive, key, value_name, data required");
        return result;
    }

    hive = parse_hive(j_hive->valuestring);
    if (!hive) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "unknown_hive");
        return result;
    }

    type_str = cJSON_IsString(j_type) ? j_type->valuestring : "REG_SZ";
    if (_stricmp(type_str, "REG_DWORD") == 0)      reg_type = REG_DWORD;
    else if (_stricmp(type_str, "REG_EXPAND_SZ") == 0) reg_type = REG_EXPAND_SZ;
    else if (_stricmp(type_str, "REG_MULTI_SZ") == 0)  reg_type = REG_MULTI_SZ;
    else                                            reg_type = REG_SZ;

    err = RegCreateKeyExA(hive, j_key->valuestring, 0, NULL,
                          REG_OPTION_NON_VOLATILE, KEY_WRITE, NULL, &hKey, &disp);
    if (err != ERROR_SUCCESS) {
        result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddNumberToObject(result, "win32_error", (double)err);
        return result;
    }

    if (reg_type == REG_DWORD && cJSON_IsNumber(j_data)) {
        DWORD dw = (DWORD)j_data->valuedouble;
        err = RegSetValueExA(hKey, j_vname->valuestring, 0, REG_DWORD,
                             (const BYTE *)&dw, sizeof(DWORD));
    } else if (cJSON_IsString(j_data)) {
        const char *str = j_data->valuestring;
        err = RegSetValueExA(hKey, j_vname->valuestring, 0, reg_type,
                             (const BYTE *)str, (DWORD)(strlen(str) + 1));
    } else {
        RegCloseKey(hKey);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "unsupported_data_type");
        return result;
    }

    RegCloseKey(hKey);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", (err == ERROR_SUCCESS) ? 1 : 0);
    if (err != ERROR_SUCCESS)
        cJSON_AddNumberToObject(result, "win32_error", (double)err);
    return result;
}

cJSON *tool_delete_registry(cJSON *params)
{
    cJSON *j_hive  = cJSON_GetObjectItemCaseSensitive(params, "hive");
    cJSON *j_key   = cJSON_GetObjectItemCaseSensitive(params, "key");
    cJSON *j_vname = cJSON_GetObjectItemCaseSensitive(params, "value_name");
    HKEY hive, hKey;
    LONG err;
    cJSON *result;

    if (!cJSON_IsString(j_hive) || !cJSON_IsString(j_key)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "hive and key required");
        return result;
    }

    hive = parse_hive(j_hive->valuestring);
    if (!hive) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "unknown_hive");
        return result;
    }

    if (cJSON_IsString(j_vname)) {
        /* Delete a specific value */
        err = RegOpenKeyExA(hive, j_key->valuestring, 0, KEY_WRITE, &hKey);
        if (err == ERROR_SUCCESS) {
            err = RegDeleteValueA(hKey, j_vname->valuestring);
            RegCloseKey(hKey);
        }
    } else {
        /* Delete the whole key */
        err = RegDeleteKeyA(hive, j_key->valuestring);
    }

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", (err == ERROR_SUCCESS) ? 1 : 0);
    if (err != ERROR_SUCCESS)
        cJSON_AddNumberToObject(result, "win32_error", (double)err);
    return result;
}

cJSON *tool_list_registry(cJSON *params)
{
    cJSON *j_hive = cJSON_GetObjectItemCaseSensitive(params, "hive");
    cJSON *j_key  = cJSON_GetObjectItemCaseSensitive(params, "key");
    HKEY hive, hKey;
    LONG err;
    DWORD i;
    DWORD max_val_name, max_val_data, max_subkey_name;
    char *vname_buf, *data_buf;
    DWORD vname_size, data_size, type;
    cJSON *result, *values_obj, *subkeys_arr;

    if (!cJSON_IsString(j_hive) || !cJSON_IsString(j_key)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "hive and key required");
        return result;
    }

    hive = parse_hive(j_hive->valuestring);
    if (!hive) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "unknown_hive");
        return result;
    }

    err = RegOpenKeyExA(hive, j_key->valuestring, 0, KEY_READ, &hKey);
    if (err != ERROR_SUCCESS) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "key_not_found");
        cJSON_AddNumberToObject(result, "win32_error", (double)err);
        return result;
    }

    /* Get buffer sizes needed */
    max_val_name = 0; max_val_data = 0; max_subkey_name = 0;
    RegQueryInfoKeyA(hKey, NULL, NULL, NULL, NULL,
                     &max_subkey_name, NULL,
                     NULL, &max_val_name, &max_val_data,
                     NULL, NULL);
    max_val_name++;
    max_val_data++;
    max_subkey_name++;

    vname_buf = (char *)malloc(max_val_name + 1);
    data_buf  = (char *)malloc(max_val_data + 2);
    if (!vname_buf || !data_buf) {
        RegCloseKey(hKey);
        free(vname_buf); free(data_buf);
        return NULL;
    }

    values_obj  = cJSON_CreateObject();
    subkeys_arr = cJSON_CreateArray();

    /* Enumerate values */
    for (i = 0; ; i++) {
        vname_size = max_val_name;
        data_size  = max_val_data;
        data_buf[0] = '\0'; data_buf[1] = '\0';

        err = RegEnumValueA(hKey, i, vname_buf, &vname_size, NULL,
                            &type, (BYTE *)data_buf, &data_size);
        if (err == ERROR_NO_MORE_ITEMS) break;
        if (err != ERROR_SUCCESS) continue;

        data_buf[data_size] = '\0';

        if (type == REG_SZ || type == REG_EXPAND_SZ) {
            cJSON_AddStringToObject(values_obj, vname_buf, data_buf);
        } else if (type == REG_DWORD) {
            cJSON_AddNumberToObject(values_obj, vname_buf,
                                   (double)(*(DWORD *)(BYTE *)data_buf));
        } else {
            char type_and_size[32];
            _snprintf(type_and_size, sizeof(type_and_size),
                      "[%s %lu bytes]", reg_type_name(type), data_size);
            cJSON_AddStringToObject(values_obj, vname_buf, type_and_size);
        }
    }

    /* Enumerate subkeys */
    {
        char *subkey_buf = (char *)malloc(max_subkey_name + 1);
        if (subkey_buf) {
            for (i = 0; ; i++) {
                DWORD subkey_size = max_subkey_name;
                err = RegEnumKeyExA(hKey, i, subkey_buf, &subkey_size,
                                    NULL, NULL, NULL, NULL);
                if (err == ERROR_NO_MORE_ITEMS) break;
                if (err != ERROR_SUCCESS) continue;
                cJSON_AddItemToArray(subkeys_arr, cJSON_CreateString(subkey_buf));
            }
            free(subkey_buf);
        }
    }

    RegCloseKey(hKey);
    free(vname_buf);
    free(data_buf);

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "values",   values_obj);
    cJSON_AddItemToObject(result, "subkeys",  subkeys_arr);
    return result;
}
