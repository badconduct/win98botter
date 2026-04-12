/*
 * system_ops.c — System information, display, hardware I/O, serial, audio,
 *                window list, and clipboard operations.
 *
 * Implements:
 *   get_system_info, get_disk_info, get_screen_resolution,
 *   set_display_settings, set_desktop_appearance,
 *   read_port, write_port, load_vxd,
 *   get_window_list, send_window_message, read_clipboard,
 *   get_comm_port_state, read_serial, write_serial,
 *   get_audio_devices, get_midi_devices
 *
 * C89/C90 — ANSI C only (VC6 target)
 */

#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "system_ops.h"
#include "cJSON.h"

/* ── get_system_info ──────────────────────────────────────────────────────── */

cJSON *tool_get_system_info(cJSON *params)
{
    OSVERSIONINFOA osi;
    SYSTEM_INFO si;
    MEMORYSTATUS ms;
    cJSON *result;
    char os_ver_str[64];
    char cpu_str[32];

    (void)params;

    ZeroMemory(&osi, sizeof(osi));
    osi.dwOSVersionInfoSize = sizeof(OSVERSIONINFOA);
    GetVersionExA(&osi);

    GetSystemInfo(&si);

    ms.dwLength = sizeof(MEMORYSTATUS);
    GlobalMemoryStatus(&ms);

    _snprintf(os_ver_str, sizeof(os_ver_str), "%lu.%lu.%lu %s",
              osi.dwMajorVersion, osi.dwMinorVersion,
              osi.dwBuildNumber & 0xFFFF, osi.szCSDVersion);

    switch (si.wProcessorArchitecture) {
        case PROCESSOR_ARCHITECTURE_INTEL: strcpy(cpu_str, "x86"); break;
        default:                           strcpy(cpu_str, "unknown"); break;
    }

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "os_version",      os_ver_str);
    cJSON_AddNumberToObject(result, "platform_id",     (double)osi.dwPlatformId);
    cJSON_AddNumberToObject(result, "num_processors",  (double)si.dwNumberOfProcessors);
    cJSON_AddStringToObject(result, "cpu_arch",        cpu_str);
    cJSON_AddNumberToObject(result, "processor_type",  (double)si.dwProcessorType);
    cJSON_AddNumberToObject(result, "total_phys_mb",
                            (double)(ms.dwTotalPhys / (1024 * 1024)));
    cJSON_AddNumberToObject(result, "avail_phys_mb",
                            (double)(ms.dwAvailPhys / (1024 * 1024)));
    cJSON_AddNumberToObject(result, "total_virtual_mb",
                            (double)(ms.dwTotalVirtual / (1024 * 1024)));
    cJSON_AddNumberToObject(result, "memory_load_pct", (double)ms.dwMemoryLoad);
    return result;
}

/* ── get_disk_info ────────────────────────────────────────────────────────── */

cJSON *tool_get_disk_info(cJSON *params)
{
    cJSON *j_drive = cJSON_GetObjectItemCaseSensitive(params, "drive");
    const char *drive = "C:\\";
    DWORD spc, bps, free_clust, total_clust;
    cJSON *result;

    if (cJSON_IsString(j_drive)) drive = j_drive->valuestring;

    result = cJSON_CreateObject();

    if (!GetDiskFreeSpaceA(drive, &spc, &bps, &free_clust, &total_clust)) {
        cJSON_AddStringToObject(result, "error", "GetDiskFreeSpace failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    {
        double bytes_per_cluster   = (double)spc * (double)bps;
        double total_bytes         = bytes_per_cluster * (double)total_clust;
        double free_bytes          = bytes_per_cluster * (double)free_clust;
        cJSON_AddStringToObject(result, "drive",          drive);
        cJSON_AddNumberToObject(result, "total_mb",       total_bytes / (1024*1024));
        cJSON_AddNumberToObject(result, "free_mb",        free_bytes  / (1024*1024));
        cJSON_AddNumberToObject(result, "used_mb",
                                (total_bytes - free_bytes) / (1024*1024));
        cJSON_AddNumberToObject(result, "bytes_per_sect", (double)bps);
        cJSON_AddNumberToObject(result, "sects_per_clust",(double)spc);
    }
    return result;
}

/* ── get_screen_resolution ────────────────────────────────────────────────── */

cJSON *tool_get_screen_resolution(cJSON *params)
{
    cJSON *result;
    DEVMODEA dm;
    (void)params;
    ZeroMemory(&dm, sizeof(dm));
    dm.dmSize = sizeof(DEVMODEA);
    EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &dm);
    result = cJSON_CreateObject();
    cJSON_AddNumberToObject(result, "width",      (double)dm.dmPelsWidth);
    cJSON_AddNumberToObject(result, "height",     (double)dm.dmPelsHeight);
    cJSON_AddNumberToObject(result, "bpp",        (double)dm.dmBitsPerPel);
    cJSON_AddNumberToObject(result, "refresh_hz", (double)dm.dmDisplayFrequency);
    return result;
}

/* ── set_display_settings ─────────────────────────────────────────────────── */

cJSON *tool_set_display_settings(cJSON *params)
{
    cJSON *j_w   = cJSON_GetObjectItemCaseSensitive(params, "width");
    cJSON *j_h   = cJSON_GetObjectItemCaseSensitive(params, "height");
    cJSON *j_bpp = cJSON_GetObjectItemCaseSensitive(params, "bpp");
    cJSON *j_hz  = cJSON_GetObjectItemCaseSensitive(params, "refresh_hz");
    DEVMODEA dm;
    LONG res;
    cJSON *result;

    ZeroMemory(&dm, sizeof(dm));
    dm.dmSize = sizeof(DEVMODEA);
    EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &dm);

    dm.dmFields = 0;
    if (cJSON_IsNumber(j_w))   { dm.dmPelsWidth  = (DWORD)j_w->valuedouble;   dm.dmFields |= DM_PELSWIDTH; }
    if (cJSON_IsNumber(j_h))   { dm.dmPelsHeight = (DWORD)j_h->valuedouble;   dm.dmFields |= DM_PELSHEIGHT; }
    if (cJSON_IsNumber(j_bpp)) { dm.dmBitsPerPel = (DWORD)j_bpp->valuedouble; dm.dmFields |= DM_BITSPERPEL; }
    if (cJSON_IsNumber(j_hz))  { dm.dmDisplayFrequency = (DWORD)j_hz->valuedouble; dm.dmFields |= DM_DISPLAYFREQUENCY; }

    res = ChangeDisplaySettingsA(&dm, 0);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", (res == DISP_CHANGE_SUCCESSFUL) ? 1 : 0);
    cJSON_AddNumberToObject(result, "result_code", (double)res);
    return result;
}

/* ── set_desktop_appearance ───────────────────────────────────────────────── */

cJSON *tool_set_desktop_appearance(cJSON *params)
{
    cJSON *j_wallpaper = cJSON_GetObjectItemCaseSensitive(params, "wallpaper");
    cJSON *result = cJSON_CreateObject();

    if (cJSON_IsString(j_wallpaper)) {
        BOOL ok = SystemParametersInfoA(SPI_SETDESKWALLPAPER, 0,
                                        (PVOID)j_wallpaper->valuestring,
                                        SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
        cJSON_AddBoolToObject(result, "wallpaper_set", ok ? 1 : 0);
    } else {
        cJSON_AddStringToObject(result, "error", "wallpaper path required");
    }
    return result;
}

/* ── read_port / write_port (x86 IN/OUT) ─────────────────────────────────── */
/*
 * Direct port I/O via inline assembler.
 * IMPORTANT: On Win98 ring-3 apps can access I/O ports only if IOPL >= 3.
 * This is the case for Win98 by default. NT/2000+ requires a driver.
 */

cJSON *tool_read_port(cJSON *params)
{
    cJSON *j_port  = cJSON_GetObjectItemCaseSensitive(params, "port");
    cJSON *j_width = cJSON_GetObjectItemCaseSensitive(params, "width");
    WORD  port;
    int   width;
    DWORD value = 0;
    cJSON *result;

    if (!cJSON_IsNumber(j_port)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "port number required");
        return result;
    }

    port  = (WORD)j_port->valuedouble;
    width = cJSON_IsNumber(j_width) ? (int)j_width->valuedouble : 8;

    if (width == 8) {
#ifdef _MSC_VER
        __asm { mov dx, port; in al, dx; mov value, eax }
#else
        { unsigned char t; __asm__ volatile("inb %%dx, %0" : "=a"(t) : "d"(port)); value = t; }
#endif
        value &= 0xFF;
    } else if (width == 16) {
#ifdef _MSC_VER
        __asm { mov dx, port; in ax, dx; mov value, eax }
#else
        { unsigned short t; __asm__ volatile("inw %%dx, %0" : "=a"(t) : "d"(port)); value = t; }
#endif
        value &= 0xFFFF;
    } else {
#ifdef _MSC_VER
        __asm { mov dx, port; in eax, dx; mov value, eax }
#else
        __asm__ volatile("inl %%dx, %0" : "=a"(value) : "d"(port));
#endif
    }

    result = cJSON_CreateObject();
    cJSON_AddNumberToObject(result, "port",  (double)port);
    cJSON_AddNumberToObject(result, "value", (double)value);
    cJSON_AddNumberToObject(result, "width", (double)width);
    return result;
}

cJSON *tool_write_port(cJSON *params)
{
    cJSON *j_port  = cJSON_GetObjectItemCaseSensitive(params, "port");
    cJSON *j_value = cJSON_GetObjectItemCaseSensitive(params, "value");
    cJSON *j_width = cJSON_GetObjectItemCaseSensitive(params, "width");
    WORD  port;
    DWORD val;
    int   width;
    cJSON *result;

    if (!cJSON_IsNumber(j_port) || !cJSON_IsNumber(j_value)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "port and value required");
        return result;
    }

    port  = (WORD)j_port->valuedouble;
    val   = (DWORD)j_value->valuedouble;
    width = cJSON_IsNumber(j_width) ? (int)j_width->valuedouble : 8;

    if (width == 8) {
#ifdef _MSC_VER
        __asm { mov dx, port; mov al, byte ptr val; out dx, al }
#else
        __asm__ volatile("outb %0, %%dx" : : "a"((unsigned char)val), "d"(port));
#endif
    } else if (width == 16) {
#ifdef _MSC_VER
        __asm { mov dx, port; mov ax, word ptr val; out dx, ax }
#else
        __asm__ volatile("outw %0, %%dx" : : "a"((unsigned short)val), "d"(port));
#endif
    } else {
#ifdef _MSC_VER
        __asm { mov dx, port; mov eax, val; out dx, eax }
#else
        __asm__ volatile("outl %0, %%dx" : : "a"(val), "d"(port));
#endif
    }

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    return result;
}

/* ── load_vxd ─────────────────────────────────────────────────────────────── */

cJSON *tool_load_vxd(cJSON *params)
{
    cJSON *j_path = cJSON_GetObjectItemCaseSensitive(params, "path");
    HANDLE h;
    cJSON *result;

    if (!cJSON_IsString(j_path)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "path required");
        return result;
    }

    /* Win98: open VxD via CreateFile with \\.\VxDName (static) or
     * via VXDLDR with a path (dynamic).
     * For a path-based VxD: prefix with \\.\ and strip .VXD extension logic
     * is complex. We use the path directly as \\.\<path> which works for
     * static VxDs. Dynamic loading is via VXDLDR service call.
     */
    h = CreateFileA(j_path->valuestring, 0, 0, NULL,
                    OPEN_EXISTING, FILE_FLAG_DELETE_ON_CLOSE, NULL);

    result = cJSON_CreateObject();
    if (h != INVALID_HANDLE_VALUE) {
        cJSON_AddBoolToObject(result, "success", 1);
        CloseHandle(h);
    } else {
        cJSON_AddBoolToObject(result, "success", 0);
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
    }
    return result;
}

/* ── Window enumeration ───────────────────────────────────────────────────── */

typedef struct {
    cJSON *arr;
    int   count;
} EnumWnd_t;

static BOOL CALLBACK enum_wnd_proc(HWND hwnd, LPARAM lp)
{
    EnumWnd_t *ctx = (EnumWnd_t *)lp;
    char title[256];
    char class_name[128];
    cJSON *entry;

    if (!IsWindowVisible(hwnd)) return TRUE;
    GetWindowTextA(hwnd, title, sizeof(title));
    GetClassNameA(hwnd,  class_name, sizeof(class_name));

    entry = cJSON_CreateObject();
    cJSON_AddNumberToObject(entry, "hwnd",       (double)(DWORD_PTR)hwnd);
    cJSON_AddStringToObject(entry, "title",      title);
    cJSON_AddStringToObject(entry, "class_name", class_name);
    cJSON_AddBoolToObject  (entry, "visible",    1);
    cJSON_AddItemToArray(ctx->arr, entry);
    ctx->count++;
    return TRUE;
}

cJSON *tool_get_window_list(cJSON *params)
{
    EnumWnd_t ctx;
    cJSON *result;
    (void)params;
    ctx.arr   = cJSON_CreateArray();
    ctx.count = 0;
    EnumWindows(enum_wnd_proc, (LPARAM)&ctx);
    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "windows", ctx.arr);
    cJSON_AddNumberToObject(result, "count", (double)ctx.count);
    return result;
}

/* ── send_window_message ──────────────────────────────────────────────────── */

cJSON *tool_send_window_message(cJSON *params)
{
    cJSON *j_hwnd  = cJSON_GetObjectItemCaseSensitive(params, "hwnd");
    cJSON *j_msg   = cJSON_GetObjectItemCaseSensitive(params, "msg");
    cJSON *j_wp    = cJSON_GetObjectItemCaseSensitive(params, "wparam");
    cJSON *j_lp    = cJSON_GetObjectItemCaseSensitive(params, "lparam");
    HWND   hwnd;
    UINT   msg;
    WPARAM wp = 0;
    LPARAM lp = 0;
    LRESULT lr;
    cJSON *result;

    if (!cJSON_IsNumber(j_hwnd) || !cJSON_IsNumber(j_msg)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "hwnd and msg required");
        return result;
    }

    hwnd = (HWND)(DWORD_PTR)(DWORD)j_hwnd->valuedouble;
    msg  = (UINT)j_msg->valuedouble;
    if (cJSON_IsNumber(j_wp)) wp = (WPARAM)(DWORD)j_wp->valuedouble;
    if (cJSON_IsNumber(j_lp)) lp = (LPARAM)(DWORD)j_lp->valuedouble;

    lr = SendMessageA(hwnd, msg, wp, lp);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddNumberToObject(result, "result", (double)(LONG)lr);
    return result;
}

/* ── read_clipboard ───────────────────────────────────────────────────────── */

cJSON *tool_read_clipboard(cJSON *params)
{
    HANDLE hData;
    const char *text;
    cJSON *result;
    (void)params;

    result = cJSON_CreateObject();

    if (!OpenClipboard(NULL)) {
        cJSON_AddStringToObject(result, "error", "OpenClipboard failed");
        return result;
    }

    hData = GetClipboardData(CF_TEXT);
    if (!hData) {
        CloseClipboard();
        cJSON_AddStringToObject(result, "text", "");
        cJSON_AddStringToObject(result, "format", "none");
        return result;
    }

    text = (const char *)GlobalLock(hData);
    if (text) {
        cJSON_AddStringToObject(result, "text", text);
        cJSON_AddStringToObject(result, "format", "CF_TEXT");
        GlobalUnlock(hData);
    }

    CloseClipboard();
    return result;
}

/* ── Serial / COM port operations ─────────────────────────────────────────── */

static HANDLE open_com(const char *port_name)
{
    char dev_path[24];
    _snprintf(dev_path, sizeof(dev_path), "\\\\.\\%s", port_name);
    return CreateFileA(dev_path,
                       GENERIC_READ | GENERIC_WRITE,
                       0, NULL, OPEN_EXISTING,
                       FILE_ATTRIBUTE_NORMAL, NULL);
}

cJSON *tool_get_comm_port_state(cJSON *params)
{
    cJSON *j_port = cJSON_GetObjectItemCaseSensitive(params, "port");
    HANDLE h;
    DCB dcb;
    cJSON *result;

    if (!cJSON_IsString(j_port)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "port name required (e.g. COM1)");
        return result;
    }

    h = open_com(j_port->valuestring);
    if (h == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "open_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    ZeroMemory(&dcb, sizeof(dcb));
    dcb.DCBlength = sizeof(DCB);
    GetCommState(h, &dcb);
    CloseHandle(h);

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "port",      j_port->valuestring);
    cJSON_AddNumberToObject(result, "baud_rate",  (double)dcb.BaudRate);
    cJSON_AddNumberToObject(result, "byte_size",  (double)dcb.ByteSize);
    cJSON_AddNumberToObject(result, "parity",     (double)dcb.Parity);
    cJSON_AddNumberToObject(result, "stop_bits",  (double)dcb.StopBits);
    cJSON_AddBoolToObject  (result, "rts_control",(dcb.fRtsControl != RTS_CONTROL_DISABLE) ? 1 : 0);
    cJSON_AddBoolToObject  (result, "dtr_control",(dcb.fDtrControl != DTR_CONTROL_DISABLE) ? 1 : 0);
    return result;
}

cJSON *tool_read_serial(cJSON *params)
{
    cJSON *j_port  = cJSON_GetObjectItemCaseSensitive(params, "port");
    cJSON *j_bytes = cJSON_GetObjectItemCaseSensitive(params, "max_bytes");
    HANDLE h;
    DWORD  max_bytes, bytes_read;
    char  *buf;
    cJSON *result;
    COMMTIMEOUTS ct;

    if (!cJSON_IsString(j_port)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "port required");
        return result;
    }

    max_bytes = cJSON_IsNumber(j_bytes) ? (DWORD)j_bytes->valuedouble : 256;
    if (max_bytes > 4096) max_bytes = 4096;

    h = open_com(j_port->valuestring);
    if (h == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "open_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    ZeroMemory(&ct, sizeof(ct));
    ct.ReadIntervalTimeout         = 50;
    ct.ReadTotalTimeoutConstant    = 200;
    ct.ReadTotalTimeoutMultiplier  = 1;
    SetCommTimeouts(h, &ct);

    buf = (char *)malloc(max_bytes + 1);
    if (!buf) { CloseHandle(h); return NULL; }
    buf[0] = '\0';
    bytes_read = 0;

    ReadFile(h, buf, max_bytes, &bytes_read, NULL);
    buf[bytes_read] = '\0';
    CloseHandle(h);

    result = cJSON_CreateObject();
    cJSON_AddNumberToObject(result, "bytes_read", (double)bytes_read);
    cJSON_AddStringToObject(result, "data",        buf);
    free(buf);
    return result;
}

cJSON *tool_write_serial(cJSON *params)
{
    cJSON *j_port = cJSON_GetObjectItemCaseSensitive(params, "port");
    cJSON *j_data = cJSON_GetObjectItemCaseSensitive(params, "data");
    HANDLE h;
    DWORD bytes_written;
    cJSON *result;

    if (!cJSON_IsString(j_port) || !cJSON_IsString(j_data)) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "port and data required");
        return result;
    }

    h = open_com(j_port->valuestring);
    if (h == INVALID_HANDLE_VALUE) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "open_failed");
        cJSON_AddNumberToObject(result, "win32_error", (double)GetLastError());
        return result;
    }

    bytes_written = 0;
    WriteFile(h, j_data->valuestring,
              (DWORD)strlen(j_data->valuestring),
              &bytes_written, NULL);
    CloseHandle(h);

    result = cJSON_CreateObject();
    cJSON_AddBoolToObject(result, "success", 1);
    cJSON_AddNumberToObject(result, "bytes_written", (double)bytes_written);
    return result;
}

/* ── Audio / MIDI device enumeration ─────────────────────────────────────── */

cJSON *tool_get_audio_devices(cJSON *params)
{
    UINT i, n;
    cJSON *result, *arr;
    (void)params;

    arr = cJSON_CreateArray();
    n   = waveInGetNumDevs();
    for (i = 0; i < n; i++) {
        WAVEINCAPSA caps;
        ZeroMemory(&caps, sizeof(caps));
        if (waveInGetDevCapsA(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR) {
            cJSON *dev = cJSON_CreateObject();
            cJSON_AddNumberToObject(dev, "id",           (double)i);
            cJSON_AddStringToObject(dev, "name",          caps.szPname);
            cJSON_AddNumberToObject(dev, "channels",     (double)caps.wChannels);
            cJSON_AddItemToArray(arr, dev);
        }
    }

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "input_devices", arr);
    cJSON_AddNumberToObject(result, "count", (double)n);
    return result;
}

cJSON *tool_get_midi_devices(cJSON *params)
{
    UINT i, n;
    cJSON *result, *arr;
    (void)params;

    arr = cJSON_CreateArray();
    n   = midiInGetNumDevs();
    for (i = 0; i < n; i++) {
        MIDIINCAPSA caps;
        ZeroMemory(&caps, sizeof(caps));
        if (midiInGetDevCapsA(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR) {
            cJSON *dev = cJSON_CreateObject();
            cJSON_AddNumberToObject(dev, "id",   (double)i);
            cJSON_AddStringToObject(dev, "name",  caps.szPname);
            cJSON_AddItemToArray(arr, dev);
        }
    }

    result = cJSON_CreateObject();
    cJSON_AddItemToObject(result, "midi_input_devices", arr);
    cJSON_AddNumberToObject(result, "count", (double)n);
    return result;
}
