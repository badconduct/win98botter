/*
 * exec_ops.c — Command execution for Win98 MCP agent
 *
 * Implements: run_command, run_bat, write_and_run_bat,
 *             start_command, get_command_status, get_command_output, stop_command,
 *             schedule_task, list_tasks, delete_task
 *
 * Execution strategy:
 *  - Creates anonymous pipes for stdout/stderr
 *  - Spawns child with CreateProcess (STARTF_USESTDHANDLES, CREATE_NO_WINDOW)
 *  - Reads pipe in a loop until child exits or timeout fires
 *  - Output capped at OUTPUT_CAPTURE_MAX_BYTES
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "exec_ops.h"
#include "cJSON.h"

/* ── Internal pipe-capture helper ─────────────────────────────────────────── */

typedef struct {
    PROCESS_INFORMATION pi;
    HANDLE hStdoutRd;   /* relay reads from here */
    HANDLE hStderrRd;
    DWORD  start_tick;
    char   id[64];
    int    in_use;
} AsyncJob;

static AsyncJob g_async[MAX_ASYNC_COMMANDS];

/* Run a command synchronously, capture up to OUTPUT_CAPTURE_MAX_BYTES.     */
static cJSON *exec_capture(const char *cmd, const char *cwd, DWORD timeout_ms)
{
    SECURITY_ATTRIBUTES sa;
    HANDLE hStdoutRd, hStdoutWr, hStderrRd, hStderrWr;
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    DWORD exit_code = 0;
    DWORD start_tick, now;
    int timed_out = 0;
    char *stdout_buf, *stderr_buf;
    DWORD stdout_len = 0, stderr_len = 0;
    DWORD bytes_avail, bytes_read;
    char read_chunk[4096];
    cJSON *result;
    char cmd_copy[32768];

    if (!cmd || strlen(cmd) >= sizeof(cmd_copy)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "command too long");
        return result;
    }
    strcpy(cmd_copy, cmd);

    /* Create pipes */
    sa.nLength              = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle       = TRUE;

    if (!CreatePipe(&hStdoutRd, &hStdoutWr, &sa, 0) ||
        !CreatePipe(&hStderrRd, &hStderrWr, &sa, 0)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "pipe_create_failed");
        return result;
    }

    /* Prevent relay side from being inherited */
    SetHandleInformation(hStdoutRd, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(hStderrRd, HANDLE_FLAG_INHERIT, 0);

    memset(&si, 0, sizeof(si));
    si.cb         = sizeof(si);
    si.hStdOutput = hStdoutWr;
    si.hStdError  = hStderrWr;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.dwFlags    = STARTF_USESTDHANDLES;

    memset(&pi, 0, sizeof(pi));

    if (!CreateProcessA(NULL, cmd_copy, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, cwd, &si, &pi)) {
        CloseHandle(hStdoutRd); CloseHandle(hStdoutWr);
        CloseHandle(hStderrRd); CloseHandle(hStderrWr);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "create_process_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    /* Close write ends in relay — child inherited them */
    CloseHandle(hStdoutWr);
    CloseHandle(hStderrWr);

    stdout_buf = (char *)malloc(OUTPUT_CAPTURE_MAX_BYTES + 1);
    stderr_buf = (char *)malloc(OUTPUT_CAPTURE_MAX_BYTES + 1);
    if (!stdout_buf || !stderr_buf) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        CloseHandle(hStdoutRd); CloseHandle(hStderrRd);
        free(stdout_buf); free(stderr_buf);
        return NULL;
    }

    start_tick = GetTickCount();

    while (1) {
        now = GetTickCount();
        if ((now - start_tick) >= timeout_ms) {
            TerminateProcess(pi.hProcess, 1);
            timed_out = 1;
        }

        /* Non-blocking drain stdout */
        while (stdout_len < OUTPUT_CAPTURE_MAX_BYTES) {
            if (!PeekNamedPipe(hStdoutRd, NULL, 0, NULL, &bytes_avail, NULL)
                || bytes_avail == 0) break;
            if (bytes_avail > sizeof(read_chunk)) bytes_avail = sizeof(read_chunk);
            if (stdout_len + bytes_avail > OUTPUT_CAPTURE_MAX_BYTES)
                bytes_avail = OUTPUT_CAPTURE_MAX_BYTES - stdout_len;
            ReadFile(hStdoutRd, read_chunk, bytes_avail, &bytes_read, NULL);
            if (bytes_read == 0) break;
            memcpy(stdout_buf + stdout_len, read_chunk, bytes_read);
            stdout_len += bytes_read;
        }

        /* Non-blocking drain stderr */
        while (stderr_len < OUTPUT_CAPTURE_MAX_BYTES) {
            if (!PeekNamedPipe(hStderrRd, NULL, 0, NULL, &bytes_avail, NULL)
                || bytes_avail == 0) break;
            if (bytes_avail > sizeof(read_chunk)) bytes_avail = sizeof(read_chunk);
            if (stderr_len + bytes_avail > OUTPUT_CAPTURE_MAX_BYTES)
                bytes_avail = OUTPUT_CAPTURE_MAX_BYTES - stderr_len;
            ReadFile(hStderrRd, read_chunk, bytes_avail, &bytes_read, NULL);
            if (bytes_read == 0) break;
            memcpy(stderr_buf + stderr_len, read_chunk, bytes_read);
            stderr_len += bytes_read;
        }

        GetExitCodeProcess(pi.hProcess, &exit_code);
        if (exit_code != STILL_ACTIVE) break;
        if (timed_out) break;

        Sleep(50); /* poll interval */
    }

    stdout_buf[stdout_len] = '\0';
    stderr_buf[stderr_len] = '\0';

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hStdoutRd);
    CloseHandle(hStderrRd);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "command",    cmd);
    cJSON_AddStringToObject(result, "stdout",     stdout_buf);
    cJSON_AddStringToObject(result, "stderr",     stderr_buf);
    cJSON_AddNumberToObject(result, "exit_code",  (double)(timed_out ? -1 : (int)exit_code));
    cJSON_AddBoolToObject(result, "timed_out",    timed_out);
    cJSON_AddNumberToObject(result, "duration_ms",(double)(GetTickCount() - start_tick));

    free(stdout_buf);
    free(stderr_buf);
    return result;
}

/* ── Tool implementations ─────────────────────────────────────────────────── */

cJSON *tool_run_command(cJSON *params)
{
    cJSON *j_cmd = cJSON_GetObjectItemCaseSensitive(params, "command");
    cJSON *j_cwd = cJSON_GetObjectItemCaseSensitive(params, "cwd");
    cJSON *j_to  = cJSON_GetObjectItemCaseSensitive(params, "timeout_ms");
    const char *cmd, *cwd;
    DWORD timeout_ms = DEFAULT_CMD_TIMEOUT_MS;

    if (!cJSON_IsString(j_cmd)) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "command required");
        return err;
    }
    cmd = j_cmd->valuestring;
    cwd = cJSON_IsString(j_cwd) ? j_cwd->valuestring : NULL;
    if (cJSON_IsNumber(j_to)) timeout_ms = (DWORD)j_to->valuedouble;

    return exec_capture(cmd, cwd, timeout_ms);
}

cJSON *tool_run_bat(cJSON *params)
{
    cJSON *j_path = cJSON_GetObjectItemCaseSensitive(params, "path");
    cJSON *j_args = cJSON_GetObjectItemCaseSensitive(params, "args");
    cJSON *j_cwd  = cJSON_GetObjectItemCaseSensitive(params, "cwd");
    cJSON *j_to   = cJSON_GetObjectItemCaseSensitive(params, "timeout_ms");
    char cmd[32768];
    const char *path, *args, *cwd;
    DWORD timeout_ms = DEFAULT_CMD_TIMEOUT_MS;

    if (!cJSON_IsString(j_path)) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "path required");
        return err;
    }

    path = j_path->valuestring;
    args = cJSON_IsString(j_args) ? j_args->valuestring : "";
    cwd  = cJSON_IsString(j_cwd)  ? j_cwd->valuestring  : NULL;
    if (cJSON_IsNumber(j_to)) timeout_ms = (DWORD)j_to->valuedouble;

    _snprintf(cmd, sizeof(cmd), "cmd.exe /c \"%s\" %s", path, args);
    return exec_capture(cmd, cwd, timeout_ms);
}

cJSON *tool_write_and_run_bat(cJSON *params)
{
    cJSON *j_content = cJSON_GetObjectItemCaseSensitive(params, "content");
    cJSON *j_cwd     = cJSON_GetObjectItemCaseSensitive(params, "cwd");
    cJSON *j_to      = cJSON_GetObjectItemCaseSensitive(params, "timeout_ms");
    HANDLE hFile;
    DWORD written;
    char bat_path[MAX_PATH_BYTES];
    char cmd[MAX_PATH_BYTES + 32];
    const char *content, *cwd;
    DWORD timeout_ms = DEFAULT_CMD_TIMEOUT_MS;
    cJSON *result;
    cJSON *exec_result;
    SYSTEMTIME st;

    if (!cJSON_IsString(j_content)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "content required");
        return result;
    }
    content = j_content->valuestring;
    cwd     = cJSON_IsString(j_cwd) ? j_cwd->valuestring : NULL;
    if (cJSON_IsNumber(j_to)) timeout_ms = (DWORD)j_to->valuedouble;

    /* Write .bat file to TEMP dir */
    GetLocalTime(&st);
    _snprintf(bat_path, sizeof(bat_path),
              "%s\\RUN_%04d%02d%02d_%02d%02d%02d.bat",
              TEMP_DIR,
              st.wYear, st.wMonth, st.wDay,
              st.wHour, st.wMinute, st.wSecond);

    /* Ensure temp dir exists */
    CreateDirectoryA(TEMP_DIR, NULL);

    hFile = CreateFileA(bat_path, GENERIC_WRITE, 0, NULL,
                        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        /* Fall back to windows TEMP */
        GetTempPathA(MAX_PATH_BYTES, bat_path);
        strcat(bat_path, "\\w98bot_run.bat");
        hFile = CreateFileA(bat_path, GENERIC_WRITE, 0, NULL,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hFile == INVALID_HANDLE_VALUE) {
            result = cJSON_CreateObject();
            cJSON_AddStringToObject(result, "error", "cannot_create_bat");
            return result;
        }
    }
    WriteFile(hFile, content, (DWORD)strlen(content), &written, NULL);
    CloseHandle(hFile);

    _snprintf(cmd, sizeof(cmd), "cmd.exe /c \"%s\"", bat_path);
    exec_result = exec_capture(cmd, cwd, timeout_ms);

    if (exec_result) {
        cJSON_AddStringToObject(exec_result, "bat_path", bat_path);
    }

    /* Clean up the temp .bat */
    DeleteFileA(bat_path);

    return exec_result;
}

/* ── Async execution ──────────────────────────────────────────────────────── */

cJSON *tool_start_command(cJSON *params)
{
    cJSON *j_id  = cJSON_GetObjectItemCaseSensitive(params, "id");
    cJSON *j_cmd = cJSON_GetObjectItemCaseSensitive(params, "command");
    cJSON *j_cwd = cJSON_GetObjectItemCaseSensitive(params, "cwd");
    const char *id, *cmd, *cwd;
    SECURITY_ATTRIBUTES sa;
    HANDLE hStdoutRd, hStdoutWr, hStderrRd, hStderrWr;
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    char cmd_copy[32768];
    int slot;
    int i;
    cJSON *result;

    if (!cJSON_IsString(j_id) || !cJSON_IsString(j_cmd)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "id and command required");
        return result;
    }
    id  = j_id->valuestring;
    cmd = j_cmd->valuestring;
    cwd = cJSON_IsString(j_cwd) ? j_cwd->valuestring : NULL;

    /* Check if id already in use */
    for (i = 0; i < MAX_ASYNC_COMMANDS; i++) {
        if (g_async[i].in_use && strcmp(g_async[i].id, id) == 0) {
            result = cJSON_CreateObject();
            cJSON_AddStringToObject(result, "error", "id_in_use");
            return result;
        }
    }

    /* Find free slot */
    slot = -1;
    for (i = 0; i < MAX_ASYNC_COMMANDS; i++) {
        if (!g_async[i].in_use) { slot = i; break; }
    }
    if (slot < 0) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "too_many_async");
        return result;
    }

    if (strlen(cmd) >= sizeof(cmd_copy)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "command too long");
        return result;
    }
    strcpy(cmd_copy, cmd);

    sa.nLength              = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle       = TRUE;

    if (!CreatePipe(&hStdoutRd, &hStdoutWr, &sa, 0) ||
        !CreatePipe(&hStderrRd, &hStderrWr, &sa, 0)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "pipe_create_failed");
        return result;
    }

    SetHandleInformation(hStdoutRd, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(hStderrRd, HANDLE_FLAG_INHERIT, 0);

    memset(&si, 0, sizeof(si));
    si.cb         = sizeof(si);
    si.hStdOutput = hStdoutWr;
    si.hStdError  = hStderrWr;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.dwFlags    = STARTF_USESTDHANDLES;

    memset(&pi, 0, sizeof(pi));

    if (!CreateProcessA(NULL, cmd_copy, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, cwd, &si, &pi)) {
        CloseHandle(hStdoutRd); CloseHandle(hStdoutWr);
        CloseHandle(hStderrRd); CloseHandle(hStderrWr);
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "create_process_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    CloseHandle(hStdoutWr);
    CloseHandle(hStderrWr);

    /* Store in slot */
    strcpy(g_async[slot].id, id);
    g_async[slot].pi         = pi;
    g_async[slot].hStdoutRd  = hStdoutRd;
    g_async[slot].hStderrRd  = hStderrRd;
    g_async[slot].start_tick = GetTickCount();
    g_async[slot].in_use     = 1;

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "started", 1);
    cJSON_AddNumberToObject(result, "pid", (double)pi.dwProcessId);
    return result;
}

static AsyncJob *find_async(const char *id)
{
    int i;
    for (i = 0; i < MAX_ASYNC_COMMANDS; i++) {
        if (g_async[i].in_use && strcmp(g_async[i].id, id) == 0)
            return &g_async[i];
    }
    return NULL;
}

cJSON *tool_get_command_status(cJSON *params)
{
    cJSON *j_id = cJSON_GetObjectItemCaseSensitive(params, "id");
    const char *id;
    AsyncJob *job;
    DWORD exit_code;
    cJSON *result;

    if (!cJSON_IsString(j_id)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "id required");
        return result;
    }
    id  = j_id->valuestring;
    job = find_async(id);
    if (!job) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "job_not_found");
        return result;
    }

    GetExitCodeProcess(job->pi.hProcess, &exit_code);
    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "id", id);
    cJSON_AddBoolToObject(result, "running", (exit_code == STILL_ACTIVE) ? 1 : 0);
    cJSON_AddNumberToObject(result, "elapsed_ms",
                            (double)(GetTickCount() - job->start_tick));
    if (exit_code != STILL_ACTIVE) {
        cJSON_AddNumberToObject(result, "exit_code", (double)(int)exit_code);
    }
    return result;
}

cJSON *tool_get_command_output(cJSON *params)
{
    cJSON *j_id      = cJSON_GetObjectItemCaseSensitive(params, "id");
    cJSON *j_max     = cJSON_GetObjectItemCaseSensitive(params, "max_bytes");
    const char *id;
    AsyncJob *job;
    DWORD max_bytes = 32768;
    char *buf;
    DWORD bytes_avail, bytes_read, total = 0;
    int has_more = 0;
    DWORD exit_code;
    cJSON *result;

    if (!cJSON_IsString(j_id)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "id required");
        return result;
    }
    id  = j_id->valuestring;
    job = find_async(id);
    if (!job) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "job_not_found");
        return result;
    }

    if (cJSON_IsNumber(j_max)) {
        max_bytes = (DWORD)j_max->valuedouble;
        if (max_bytes > OUTPUT_CAPTURE_MAX_BYTES)
            max_bytes = OUTPUT_CAPTURE_MAX_BYTES;
    }

    buf = (char *)malloc(max_bytes + 1);
    if (!buf) return NULL;

    if (PeekNamedPipe(job->hStdoutRd, NULL, 0, NULL, &bytes_avail, NULL) && bytes_avail > 0) {
        DWORD to_read = (bytes_avail < max_bytes) ? bytes_avail : max_bytes;
        ReadFile(job->hStdoutRd, buf, to_read, &bytes_read, NULL);
        total = bytes_read;
    }
    buf[total] = '\0';

    /* Check if more data waiting */
    has_more = 0;
    if (PeekNamedPipe(job->hStdoutRd, NULL, 0, NULL, &bytes_avail, NULL) && bytes_avail > 0)
        has_more = 1;

    GetExitCodeProcess(job->pi.hProcess, &exit_code);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "id",       id);
    cJSON_AddStringToObject(result, "stdout",   buf);
    cJSON_AddBoolToObject(result, "has_more",   has_more);
    cJSON_AddBoolToObject(result, "running",    (exit_code == STILL_ACTIVE) ? 1 : 0);
    if (exit_code != STILL_ACTIVE)
        cJSON_AddNumberToObject(result, "exit_code", (double)(int)exit_code);

    free(buf);
    return result;
}

cJSON *tool_stop_command(cJSON *params)
{
    cJSON *j_id = cJSON_GetObjectItemCaseSensitive(params, "id");
    const char *id;
    AsyncJob *job;
    cJSON *result;

    if (!cJSON_IsString(j_id)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "id required");
        return result;
    }
    id  = j_id->valuestring;
    job = find_async(id);
    if (!job) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "job_not_found");
        return result;
    }

    TerminateProcess(job->pi.hProcess, 1);
    CloseHandle(job->pi.hProcess);
    CloseHandle(job->pi.hThread);
    CloseHandle(job->hStdoutRd);
    CloseHandle(job->hStderrRd);
    memset(job, 0, sizeof(*job));

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    return result;
}

/* ── Task Scheduler (AT command wrapper) ─────────────────────────────────── */

cJSON *tool_schedule_task(cJSON *params)
{
    /* j_name not used — task id is returned by AT.EXE output parsing */
    cJSON *j_time = cJSON_GetObjectItemCaseSensitive(params, "time");
    cJSON *j_cmd  = cJSON_GetObjectItemCaseSensitive(params, "command");
    cJSON *j_days = cJSON_GetObjectItemCaseSensitive(params, "days");
    char at_cmd[512];
    const char *time_str, *cmd_str, *days_str;
    cJSON *exec_result, *result;

    if (!cJSON_IsString(j_time) || !cJSON_IsString(j_cmd)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "time and command required");
        return result;
    }
    time_str = j_time->valuestring;
    cmd_str  = j_cmd->valuestring;
    days_str = cJSON_IsString(j_days) ? j_days->valuestring : "M T W Th F Sa Su";

    _snprintf(at_cmd, sizeof(at_cmd),
              "at %s /every:%s \"%s\"",
              time_str, days_str, cmd_str);

    exec_result = tool_run_command(params);  /* will fail — rebuild */
    if (exec_result) { cJSON_Delete(exec_result); exec_result = NULL; }

    /* Build the proper params for run_command */
    {
        cJSON *p = cJSON_CreateObject();
        cJSON_AddStringToObject(p, "command", at_cmd);
        exec_result = tool_run_command(p);
        cJSON_Delete(p);
    }

    result = cJSON_CreateObject();
    if (exec_result) {
        cJSON *j_exit = cJSON_GetObjectItemCaseSensitive(exec_result, "exit_code");
        int ok = (cJSON_IsNumber(j_exit) && (int)j_exit->valuedouble == 0);
        cJSON_AddBoolToObject(result, "success", ok);
        if (!ok) {
            cJSON *j_out = cJSON_GetObjectItemCaseSensitive(exec_result, "stdout");
            cJSON_AddStringToObject(result, "output",
                cJSON_IsString(j_out) ? j_out->valuestring : "");
        }
        cJSON_Delete(exec_result);
    } else {
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddStringToObject(result, "error", "exec_failed");
    }
    return result;
}

cJSON *tool_list_tasks(cJSON *params)
{
    cJSON *p = cJSON_CreateObject();
    cJSON *exec_result;
    cJSON *result;
    (void)params;

    cJSON_AddStringToObject(p, "command", "at");
    exec_result = tool_run_command(p);
    cJSON_Delete(p);

    result = cJSON_CreateObject();
    if (exec_result) {
        cJSON *j_out = cJSON_GetObjectItemCaseSensitive(exec_result, "stdout");
        cJSON_AddStringToObject(result, "raw_output",
            cJSON_IsString(j_out) ? j_out->valuestring : "");
        cJSON_Delete(exec_result);
    }
    /* Parse would require additional logic; relay handles it via LLM */
    return result;
}

cJSON *tool_delete_task(cJSON *params)
{
    cJSON *j_id = cJSON_GetObjectItemCaseSensitive(params, "id");
    char at_cmd[64];
    cJSON *p, *exec_result, *result;
    int task_id;

    if (!cJSON_IsNumber(j_id)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "id required");
        return result;
    }
    task_id = (int)j_id->valuedouble;
    _snprintf(at_cmd, sizeof(at_cmd), "at /delete /id:%d /yes", task_id);

    p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "command", at_cmd);
    exec_result = tool_run_command(p);
    cJSON_Delete(p);

    result = cJSON_CreateObject();
    if (exec_result) {
        cJSON *j_exit = cJSON_GetObjectItemCaseSensitive(exec_result, "exit_code");
        cJSON_AddBoolToObject(result, "success",
            (cJSON_IsNumber(j_exit) && (int)j_exit->valuedouble == 0) ? 1 : 0);
        cJSON_Delete(exec_result);
    } else {
        cJSON_AddBoolToObject(result, "success", 0);
    }
    return result;
}
