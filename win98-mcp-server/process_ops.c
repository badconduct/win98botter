/*
 * process_ops.c — Process listing and kill operations
 *
 * Implements: list_processes, kill_process
 *
 * Uses CreateToolhelp32Snapshot (TOOLHELP32.DLL — present on Win98).
 * Memory info via PSAPI.DLL (may not be present; gracefully omitted if absent).
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "process_ops.h"
#include "cJSON.h"

/*
 * PSAPI is not guaranteed on Win98. We load it dynamically.
 * If absent, mem_kb will be 0.
 */
typedef BOOL (WINAPI *PFN_GetProcessMemoryInfo)(HANDLE, void *, DWORD);
static PFN_GetProcessMemoryInfo pfnGetProcessMemoryInfo = NULL;
static HMODULE hPsapi = NULL;

/* PROCESS_MEMORY_COUNTERS — replicate here to avoid psapi.h dependency */
typedef struct {
    DWORD  cb;
    DWORD  PageFaultCount;
    SIZE_T PeakWorkingSetSize;
    SIZE_T WorkingSetSize;
    SIZE_T QuotaPeakPagedPoolUsage;
    SIZE_T QuotaPagedPoolUsage;
    SIZE_T QuotaPeakNonPagedPoolUsage;
    SIZE_T QuotaNonPagedPoolUsage;
    SIZE_T PagefileUsage;
    SIZE_T PeakPagefileUsage;
} PMC_LITE;

static void try_load_psapi(void)
{
    if (hPsapi) return;
    hPsapi = LoadLibraryA("PSAPI.DLL");
    if (hPsapi) {
        pfnGetProcessMemoryInfo = (PFN_GetProcessMemoryInfo)
            GetProcAddress(hPsapi, "GetProcessMemoryInfo");
    }
}

static DWORD get_proc_mem_kb(DWORD pid)
{
    HANDLE hProc;
    PMC_LITE pmc;
    DWORD mem_kb = 0;
    try_load_psapi();
    if (!pfnGetProcessMemoryInfo) return 0;
    hProc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!hProc) return 0;
    ZeroMemory(&pmc, sizeof(pmc));
    pmc.cb = sizeof(pmc);
    if (pfnGetProcessMemoryInfo(hProc, &pmc, sizeof(pmc)))
        mem_kb = (DWORD)(pmc.WorkingSetSize / 1024);
    CloseHandle(hProc);
    return mem_kb;
}

/* ── Tool: list_processes ─────────────────────────────────────────────────── */

cJSON *tool_list_processes(cJSON *params)
{
    HANDLE snap;
    PROCESSENTRY32 pe;
    cJSON *result, *arr;

    (void)params; /* unused */

    snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "snapshot_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    arr = cJSON_CreateArray();
    ZeroMemory(&pe, sizeof(pe));
    pe.dwSize = sizeof(PROCESSENTRY32);

    if (Process32First(snap, &pe)) {
        do {
            cJSON *entry = cJSON_CreateObject();
            DWORD mem_kb = get_proc_mem_kb(pe.th32ProcessID);
            cJSON_AddStringToObject(entry, "name", pe.szExeFile);
            cJSON_AddNumberToObject(entry, "pid",  (double)pe.th32ProcessID);
            cJSON_AddNumberToObject(entry, "threads", (double)pe.cntThreads);
            cJSON_AddNumberToObject(entry, "mem_kb",  (double)mem_kb);
            cJSON_AddItemToArray(arr, entry);
        } while (Process32Next(snap, &pe));
    }

    CloseHandle(snap);

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "processes", arr);
    return result;
}

/* ── Tool: kill_process ───────────────────────────────────────────────────── */

cJSON *tool_kill_process(cJSON *params)
{
    cJSON *j_pid  = cJSON_GetObjectItemCaseSensitive(params, "pid");
    cJSON *j_name = cJSON_GetObjectItemCaseSensitive(params, "name");
    HANDLE hProc  = NULL;
    BOOL   ok     = FALSE;
    int    killed = 0;
    cJSON *result;

    if (cJSON_IsNumber(j_pid)) {
        /* Kill by PID */
        DWORD pid = (DWORD)j_pid->valuedouble;
        hProc = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
        if (hProc) {
            ok = TerminateProcess(hProc, 1);
            CloseHandle(hProc);
            killed = ok ? 1 : 0;
        }
    } else if (cJSON_IsString(j_name)) {
        /* Kill all processes matching name */
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32 pe;
            ZeroMemory(&pe, sizeof(pe));
            pe.dwSize = sizeof(PROCESSENTRY32);
            if (Process32First(snap, &pe)) {
                do {
                    if (_stricmp(pe.szExeFile, j_name->valuestring) == 0) {
                        hProc = OpenProcess(PROCESS_TERMINATE, FALSE,
                                            pe.th32ProcessID);
                        if (hProc) {
                            if (TerminateProcess(hProc, 1)) killed++;
                            CloseHandle(hProc);
                        }
                    }
                } while (Process32Next(snap, &pe));
            }
            CloseHandle(snap);
        }
    } else {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "pid or name required");
        return result;
    }

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success",      (killed > 0) ? 1 : 0);
    cJSON_AddNumberToObject(result, "killed_count", (double)killed);
    if (!killed)
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
    return result;
}
