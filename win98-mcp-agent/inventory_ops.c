/*
 * inventory_ops.c - registry-backed inventory for Windows 98 SE.
 *
 * Win98 does not have MSI/WMI or a modern Device Manager API contract that is
 * dependable across every installation. Its Uninstall, App Paths, Run, Shell
 * Folders, and HKLM\Enum registry trees are the authoritative compatibility
 * sources used here.
 *
 * C89/C90 - ANSI C only (VC6 target).
 */

#include <windows.h>
#include <winreg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "inventory_ops.h"
#include "cJSON.h"

#define INVENTORY_TEXT_MAX 2048
#define INVENTORY_KEY_MAX   512

static int query_string(HKEY key, const char *name, char *out, DWORD out_size)
{
    DWORD type;
    DWORD size;
    LONG rc;

    if (!out || out_size == 0) return 0;
    out[0] = '\0';
    size = out_size - 1;
    rc = RegQueryValueExA(key, name, NULL, &type, (BYTE *)out, &size);
    if (rc != ERROR_SUCCESS) return 0;
    if (type != REG_SZ && type != REG_EXPAND_SZ && type != REG_MULTI_SZ) {
        out[0] = '\0';
        return 0;
    }
    out[out_size - 1] = '\0';
    return out[0] != '\0';
}

static int query_dword(HKEY key, const char *name, DWORD *out)
{
    DWORD type;
    DWORD size;
    LONG rc;

    if (!out) return 0;
    size = sizeof(DWORD);
    rc = RegQueryValueExA(key, name, NULL, &type, (BYTE *)out, &size);
    return rc == ERROR_SUCCESS && type == REG_DWORD && size == sizeof(DWORD);
}

static int get_max_results(cJSON *params, int default_value, int hard_max)
{
    cJSON *j_max;
    int value;

    j_max = cJSON_GetObjectItemCaseSensitive(params, "max_results");
    value = cJSON_IsNumber(j_max) ? j_max->valueint : default_value;
    if (value < 1) value = 1;
    if (value > hard_max) value = hard_max;
    return value;
}

static void add_optional_string(cJSON *obj, const char *json_name,
                                HKEY key, const char *value_name)
{
    char value[INVENTORY_TEXT_MAX];
    if (query_string(key, value_name, value, sizeof(value))) {
        cJSON_AddStringToObject(obj, json_name, value);
    }
}

static void collect_uninstall_hive(HKEY hive, const char *hive_name,
                                   cJSON *apps, int max_results,
                                   int *count, int *truncated)
{
    static const char base[] =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    HKEY root;
    HKEY app_key;
    DWORD index;
    char subkey[256];
    DWORD subkey_size;
    char display_name[INVENTORY_TEXT_MAX];
    char full_key[INVENTORY_KEY_MAX];
    LONG rc;

    rc = RegOpenKeyExA(hive, base, 0, KEY_READ, &root);
    if (rc != ERROR_SUCCESS) return;

    for (index = 0; ; index++) {
        cJSON *entry;
        subkey_size = sizeof(subkey) - 1;
        rc = RegEnumKeyExA(root, index, subkey, &subkey_size,
                           NULL, NULL, NULL, NULL);
        if (rc == ERROR_NO_MORE_ITEMS) break;
        if (rc != ERROR_SUCCESS) continue;
        subkey[subkey_size] = '\0';

        if (*count >= max_results) {
            *truncated = 1;
            break;
        }
        if (RegOpenKeyExA(root, subkey, 0, KEY_READ, &app_key) != ERROR_SUCCESS)
            continue;
        if (!query_string(app_key, "DisplayName", display_name,
                          sizeof(display_name))) {
            RegCloseKey(app_key);
            continue;
        }

        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "name", display_name);
        cJSON_AddStringToObject(entry, "hive", hive_name);
        _snprintf(full_key, sizeof(full_key), "%s\\%s", base, subkey);
        full_key[sizeof(full_key) - 1] = '\0';
        cJSON_AddStringToObject(entry, "registry_key", full_key);
        add_optional_string(entry, "version", app_key, "DisplayVersion");
        add_optional_string(entry, "publisher", app_key, "Publisher");
        add_optional_string(entry, "install_location", app_key, "InstallLocation");
        add_optional_string(entry, "install_source", app_key, "InstallSource");
        add_optional_string(entry, "uninstall_command", app_key, "UninstallString");
        cJSON_AddItemToArray(apps, entry);
        (*count)++;
        RegCloseKey(app_key);
    }
    RegCloseKey(root);
}

static void collect_app_paths(HKEY hive, const char *hive_name,
                              cJSON *paths, int max_results,
                              int *count, int *truncated)
{
    static const char base[] =
        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths";
    HKEY root;
    HKEY app_key;
    DWORD index;
    char subkey[256];
    DWORD subkey_size;
    char executable[INVENTORY_TEXT_MAX];
    LONG rc;

    rc = RegOpenKeyExA(hive, base, 0, KEY_READ, &root);
    if (rc != ERROR_SUCCESS) return;
    for (index = 0; ; index++) {
        cJSON *entry;
        subkey_size = sizeof(subkey) - 1;
        rc = RegEnumKeyExA(root, index, subkey, &subkey_size,
                           NULL, NULL, NULL, NULL);
        if (rc == ERROR_NO_MORE_ITEMS) break;
        if (rc != ERROR_SUCCESS) continue;
        subkey[subkey_size] = '\0';
        if (*count >= max_results) {
            *truncated = 1;
            break;
        }
        if (RegOpenKeyExA(root, subkey, 0, KEY_READ, &app_key) != ERROR_SUCCESS)
            continue;
        if (!query_string(app_key, NULL, executable, sizeof(executable))) {
            RegCloseKey(app_key);
            continue;
        }
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "name", subkey);
        cJSON_AddStringToObject(entry, "executable", executable);
        cJSON_AddStringToObject(entry, "hive", hive_name);
        add_optional_string(entry, "search_path", app_key, "Path");
        cJSON_AddItemToArray(paths, entry);
        (*count)++;
        RegCloseKey(app_key);
    }
    RegCloseKey(root);
}

cJSON *tool_list_installed_apps(cJSON *params)
{
    cJSON *result;
    cJSON *apps;
    cJSON *app_paths;
    int max_results;
    int app_count;
    int path_count;
    int truncated;

    max_results = get_max_results(params, 250, 1000);
    app_count = 0;
    path_count = 0;
    truncated = 0;
    apps = cJSON_CreateArray();
    app_paths = cJSON_CreateArray();

    collect_uninstall_hive(HKEY_LOCAL_MACHINE, "HKLM", apps, max_results,
                           &app_count, &truncated);
    if (!truncated) {
        collect_uninstall_hive(HKEY_CURRENT_USER, "HKCU", apps, max_results,
                               &app_count, &truncated);
    }
    collect_app_paths(HKEY_LOCAL_MACHINE, "HKLM", app_paths, max_results,
                      &path_count, &truncated);
    if (!truncated) {
        collect_app_paths(HKEY_CURRENT_USER, "HKCU", app_paths, max_results,
                          &path_count, &truncated);
    }

    result = cJSON_CreateObject();
    cJSON_AddNumberToObject(result, "installed_count", (double)app_count);
    cJSON_AddNumberToObject(result, "app_path_count", (double)path_count);
    cJSON_AddBoolToObject(result, "truncated", truncated ? 1 : 0);
    cJSON_AddStringToObject(result, "source",
                            "Uninstall and App Paths registry keys");
    cJSON_AddItemToObject(result, "installed_apps", apps);
    cJSON_AddItemToObject(result, "app_paths", app_paths);
    return result;
}

static void collect_run_key(HKEY hive, const char *hive_name,
                            const char *key_path, cJSON *items,
                            int max_results, int *count, int *truncated)
{
    HKEY key;
    DWORD index;
    char name[256];
    char data[INVENTORY_TEXT_MAX];
    DWORD name_size;
    DWORD data_size;
    DWORD type;
    LONG rc;

    if (*count >= max_results) {
        *truncated = 1;
        return;
    }
    if (RegOpenKeyExA(hive, key_path, 0, KEY_READ, &key) != ERROR_SUCCESS)
        return;

    for (index = 0; ; index++) {
        cJSON *entry;
        name_size = sizeof(name) - 1;
        data_size = sizeof(data) - 1;
        rc = RegEnumValueA(key, index, name, &name_size, NULL,
                           &type, (BYTE *)data, &data_size);
        if (rc == ERROR_NO_MORE_ITEMS) break;
        if (rc != ERROR_SUCCESS) continue;
        if (type != REG_SZ && type != REG_EXPAND_SZ) continue;
        name[name_size] = '\0';
        data[data_size < sizeof(data) ? data_size : sizeof(data) - 1] = '\0';
        if (*count >= max_results) {
            *truncated = 1;
            break;
        }
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "name", name);
        cJSON_AddStringToObject(entry, "command", data);
        cJSON_AddStringToObject(entry, "source", "registry");
        cJSON_AddStringToObject(entry, "hive", hive_name);
        cJSON_AddStringToObject(entry, "location", key_path);
        cJSON_AddItemToArray(items, entry);
        (*count)++;
    }
    RegCloseKey(key);
}

static void add_win_ini_item(const char *name, const char *command,
                             const char *win_ini, cJSON *items,
                             int max_results, int *count, int *truncated)
{
    cJSON *entry;

    if (!command || !command[0]) return;
    if (*count >= max_results) {
        *truncated = 1;
        return;
    }
    entry = cJSON_CreateObject();
    cJSON_AddStringToObject(entry, "name", name);
    cJSON_AddStringToObject(entry, "command", command);
    cJSON_AddStringToObject(entry, "source", "win.ini");
    cJSON_AddStringToObject(entry, "location", win_ini);
    cJSON_AddItemToArray(items, entry);
    (*count)++;
}

static void collect_startup_folder(const char *folder, const char *source,
                                   cJSON *items, int max_results,
                                   int *count, int *truncated)
{
    char search[INVENTORY_KEY_MAX];
    char full_path[INVENTORY_KEY_MAX];
    WIN32_FIND_DATAA ffd;
    HANDLE find;

    if (!folder || !folder[0] || *count >= max_results) return;
    _snprintf(search, sizeof(search), "%s\\*.*", folder);
    search[sizeof(search) - 1] = '\0';
    find = FindFirstFileA(search, &ffd);
    if (find == INVALID_HANDLE_VALUE) return;
    do {
        cJSON *entry;
        if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (*count >= max_results) {
            *truncated = 1;
            break;
        }
        _snprintf(full_path, sizeof(full_path), "%s\\%s", folder, ffd.cFileName);
        full_path[sizeof(full_path) - 1] = '\0';
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "name", ffd.cFileName);
        cJSON_AddStringToObject(entry, "command", full_path);
        cJSON_AddStringToObject(entry, "source", source);
        cJSON_AddStringToObject(entry, "location", folder);
        cJSON_AddItemToArray(items, entry);
        (*count)++;
    } while (FindNextFileA(find, &ffd));
    FindClose(find);
}

static int read_shell_folder(HKEY hive, const char *value_name,
                             char *out, DWORD out_size)
{
    static const char key_path[] =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders";
    HKEY key;
    int ok;

    if (RegOpenKeyExA(hive, key_path, 0, KEY_READ, &key) != ERROR_SUCCESS)
        return 0;
    ok = query_string(key, value_name, out, out_size);
    RegCloseKey(key);
    return ok;
}

cJSON *tool_list_startup_items(cJSON *params)
{
    static const char *run_keys[] = {
        "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
        "Software\\Microsoft\\Windows\\CurrentVersion\\RunServices",
        "Software\\Microsoft\\Windows\\CurrentVersion\\RunServicesOnce",
        NULL
    };
    cJSON *result;
    cJSON *items;
    int max_results;
    int count;
    int truncated;
    int i;
    char windows_dir[MAX_PATH];
    char win_ini[MAX_PATH];
    char value[INVENTORY_TEXT_MAX];
    char startup[INVENTORY_KEY_MAX];
    char common_startup[INVENTORY_KEY_MAX];

    max_results = get_max_results(params, 250, 1000);
    count = 0;
    truncated = 0;
    items = cJSON_CreateArray();

    for (i = 0; run_keys[i] != NULL && !truncated; i++) {
        collect_run_key(HKEY_LOCAL_MACHINE, "HKLM", run_keys[i], items,
                        max_results, &count, &truncated);
        collect_run_key(HKEY_CURRENT_USER, "HKCU", run_keys[i], items,
                        max_results, &count, &truncated);
    }

    windows_dir[0] = '\0';
    GetWindowsDirectoryA(windows_dir, sizeof(windows_dir));
    _snprintf(win_ini, sizeof(win_ini), "%s\\WIN.INI", windows_dir);
    win_ini[sizeof(win_ini) - 1] = '\0';
    value[0] = '\0';
    GetPrivateProfileStringA("windows", "run", "", value,
                             sizeof(value), win_ini);
    add_win_ini_item("run", value, win_ini, items, max_results,
                     &count, &truncated);
    value[0] = '\0';
    GetPrivateProfileStringA("windows", "load", "", value,
                             sizeof(value), win_ini);
    add_win_ini_item("load", value, win_ini, items, max_results,
                     &count, &truncated);

    startup[0] = '\0';
    common_startup[0] = '\0';
    if (read_shell_folder(HKEY_CURRENT_USER, "Startup", startup,
                          sizeof(startup))) {
        collect_startup_folder(startup, "startup_folder", items,
                               max_results, &count, &truncated);
    }
    if (read_shell_folder(HKEY_LOCAL_MACHINE, "Common Startup", common_startup,
                          sizeof(common_startup)) &&
        _stricmp(startup, common_startup) != 0) {
        collect_startup_folder(common_startup, "common_startup_folder", items,
                               max_results, &count, &truncated);
    }

    result = cJSON_CreateObject();
    cJSON_AddNumberToObject(result, "count", (double)count);
    cJSON_AddBoolToObject(result, "truncated", truncated ? 1 : 0);
    cJSON_AddItemToObject(result, "items", items);
    return result;
}

static void collect_device_instance(HKEY instance_key,
                                    const char *instance_id,
                                    const char *class_filter,
                                    int problem_only,
                                    cJSON *devices,
                                    int max_results,
                                    int *count,
                                    int *truncated)
{
    char description[INVENTORY_TEXT_MAX];
    char friendly[INVENTORY_TEXT_MAX];
    char class_name[256];
    DWORD problem;
    DWORD status_flags;
    int has_problem;
    cJSON *entry;

    description[0] = '\0';
    friendly[0] = '\0';
    class_name[0] = '\0';
    query_string(instance_key, "DeviceDesc", description, sizeof(description));
    query_string(instance_key, "FriendlyName", friendly, sizeof(friendly));
    query_string(instance_key, "Class", class_name, sizeof(class_name));
    problem = 0;
    status_flags = 0;
    query_dword(instance_key, "Problem", &problem);
    query_dword(instance_key, "StatusFlags", &status_flags);
    has_problem = problem != 0;

    if (!description[0] && !friendly[0] && !class_name[0]) return;
    if (class_filter && class_filter[0] &&
        _stricmp(class_filter, class_name) != 0) return;
    if (problem_only && !has_problem) return;
    if (*count >= max_results) {
        *truncated = 1;
        return;
    }

    entry = cJSON_CreateObject();
    cJSON_AddStringToObject(entry, "instance_id", instance_id);
    cJSON_AddStringToObject(entry, "name",
                            friendly[0] ? friendly : description);
    if (description[0]) cJSON_AddStringToObject(entry, "description", description);
    if (class_name[0]) cJSON_AddStringToObject(entry, "class", class_name);
    add_optional_string(entry, "manufacturer", instance_key, "Mfg");
    add_optional_string(entry, "driver", instance_key, "Driver");
    add_optional_string(entry, "hardware_id", instance_key, "HardwareID");
    cJSON_AddNumberToObject(entry, "problem_code", (double)problem);
    cJSON_AddNumberToObject(entry, "status_flags", (double)status_flags);
    cJSON_AddBoolToObject(entry, "has_problem", has_problem ? 1 : 0);
    cJSON_AddItemToArray(devices, entry);
    (*count)++;
}

cJSON *tool_list_devices(cJSON *params)
{
    cJSON *j_class;
    cJSON *j_problem;
    cJSON *result;
    cJSON *devices;
    const char *class_filter;
    int problem_only;
    int max_results;
    int count;
    int truncated;
    HKEY enum_root;
    HKEY bus_key;
    HKEY device_key;
    HKEY instance_key;
    DWORD bus_index;
    DWORD device_index;
    DWORD instance_index;
    DWORD name_size;
    char bus[256];
    char device[256];
    char instance[256];
    char instance_id[INVENTORY_KEY_MAX];
    LONG rc;

    j_class = cJSON_GetObjectItemCaseSensitive(params, "class");
    j_problem = cJSON_GetObjectItemCaseSensitive(params, "problem_only");
    class_filter = cJSON_IsString(j_class) ? j_class->valuestring : NULL;
    problem_only = cJSON_IsBool(j_problem) ? cJSON_IsTrue(j_problem) : 0;
    max_results = get_max_results(params, 500, 2000);
    count = 0;
    truncated = 0;
    devices = cJSON_CreateArray();

    rc = RegOpenKeyExA(HKEY_LOCAL_MACHINE, "Enum", 0, KEY_READ, &enum_root);
    if (rc != ERROR_SUCCESS) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "HKLM\\Enum unavailable");
        cJSON_AddNumberToObject(result, "win32_error", (double)rc);
        cJSON_AddItemToObject(result, "devices", devices);
        return result;
    }

    for (bus_index = 0; !truncated; bus_index++) {
        name_size = sizeof(bus) - 1;
        rc = RegEnumKeyExA(enum_root, bus_index, bus, &name_size,
                           NULL, NULL, NULL, NULL);
        if (rc == ERROR_NO_MORE_ITEMS) break;
        if (rc != ERROR_SUCCESS) continue;
        bus[name_size] = '\0';
        if (RegOpenKeyExA(enum_root, bus, 0, KEY_READ, &bus_key) != ERROR_SUCCESS)
            continue;

        for (device_index = 0; !truncated; device_index++) {
            name_size = sizeof(device) - 1;
            rc = RegEnumKeyExA(bus_key, device_index, device, &name_size,
                               NULL, NULL, NULL, NULL);
            if (rc == ERROR_NO_MORE_ITEMS) break;
            if (rc != ERROR_SUCCESS) continue;
            device[name_size] = '\0';
            if (RegOpenKeyExA(bus_key, device, 0, KEY_READ, &device_key) !=
                ERROR_SUCCESS) continue;

            for (instance_index = 0; !truncated; instance_index++) {
                name_size = sizeof(instance) - 1;
                rc = RegEnumKeyExA(device_key, instance_index, instance,
                                   &name_size, NULL, NULL, NULL, NULL);
                if (rc == ERROR_NO_MORE_ITEMS) break;
                if (rc != ERROR_SUCCESS) continue;
                instance[name_size] = '\0';
                if (RegOpenKeyExA(device_key, instance, 0, KEY_READ,
                                  &instance_key) != ERROR_SUCCESS) continue;
                _snprintf(instance_id, sizeof(instance_id), "%s\\%s\\%s",
                          bus, device, instance);
                instance_id[sizeof(instance_id) - 1] = '\0';
                collect_device_instance(instance_key, instance_id,
                                        class_filter, problem_only, devices,
                                        max_results, &count, &truncated);
                RegCloseKey(instance_key);
            }
            RegCloseKey(device_key);
        }
        RegCloseKey(bus_key);
    }
    RegCloseKey(enum_root);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "source", "HKLM\\Enum");
    cJSON_AddNumberToObject(result, "count", (double)count);
    cJSON_AddBoolToObject(result, "truncated", truncated ? 1 : 0);
    cJSON_AddBoolToObject(result, "problem_only", problem_only ? 1 : 0);
    if (class_filter && class_filter[0]) {
        cJSON_AddStringToObject(result, "class_filter", class_filter);
    }
    cJSON_AddItemToObject(result, "devices", devices);
    return result;
}
