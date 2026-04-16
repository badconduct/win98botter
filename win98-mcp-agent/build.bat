@echo off
rem build.bat — Build win98-mcp-server.exe with VC6 command-line tools
rem
rem Prerequisites:
rem   1. VC6 (Visual C++ 6.0) installed on path, or run from the VC98\Bin vcvars32.bat
rem   2. cJSON.c and cJSON.h present in this directory
rem      Download from: https://github.com/DaveGamble/cJSON/releases/tag/v1.7.18
rem      (cJSON.c and cJSON.h from that release work with C89/VC6)
rem
rem Usage:
rem   build.bat               — release build
rem   build.bat DEBUG=1       — debug build (no optimisation, /Zi)

setlocal

set OUT=win98-mcp-server.exe
set DEFINES=/DWIN32 /D_WIN32_WINNT=0x0400 /DWIN32_LEAN_AND_MEAN /D_CRT_SECURE_NO_WARNINGS

if "%1"=="DEBUG=1" (
    set CFLAGS=/c /W3 /Zi /Od %DEFINES%
    set LFLAGS=/DEBUG
) else (
    set CFLAGS=/c /W3 /O2 %DEFINES%
    set LFLAGS=
)

echo.
echo [BUILD] Compiling sources...
echo.

cl.exe %CFLAGS% ^
    mcp_server.c  ^
    cli_mode.c    ^
    file_ops.c    ^
    exec_ops.c    ^
    ini_ops.c     ^
    ipc_ops.c     ^
    registry_ops.c ^
    process_ops.c ^
    system_ops.c  ^
    permissions.c ^
    cJSON.c

if errorlevel 1 (
    echo.
    echo [BUILD] *** Compile FAILED ***
    exit /b 1
)

echo.
echo [BUILD] Linking...
echo.

link.exe /nologo /SUBSYSTEM:CONSOLE %LFLAGS% ^
    /OUT:%OUT% ^
    mcp_server.obj  ^
    cli_mode.obj    ^
    file_ops.obj    ^
    exec_ops.obj    ^
    ini_ops.obj     ^
    ipc_ops.obj     ^
    registry_ops.obj ^
    process_ops.obj ^
    system_ops.obj  ^
    permissions.obj ^
    cJSON.obj       ^
    kernel32.lib user32.lib advapi32.lib wsock32.lib winmm.lib

if errorlevel 1 (
    echo.
    echo [BUILD] *** Link FAILED ***
    exit /b 1
)

echo.
echo [BUILD] Done: %OUT%
echo.

endlocal
