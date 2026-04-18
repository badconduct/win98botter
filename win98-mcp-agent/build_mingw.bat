@echo off
rem build_mingw.bat - Build win98-mcp-server.exe with MinGW-w64 (i686 target)
rem
rem Easier alternative to VC6. Works from modern Windows or on Win98 with MinGW.
rem
rem Prerequisites:
rem   1. MinGW-w64 i686 toolchain on PATH.
rem      Recommended: https://winlibs.com/  (grab the i686 release)
rem      Or:          choco install mingw    (installs 64-bit, but i686 build
rem                   still produces Win98-compatible output)
rem   2. cJSON.c and cJSON.h present in this directory.
rem      Download from: https://github.com/DaveGamble/cJSON/releases/tag/v1.7.18
rem
rem Usage:
rem   build_mingw.bat           - release build
rem   build_mingw.bat DEBUG=1   - debug build

setlocal

rem Prefer the i686 MinGW toolchain on S:\mingw32 if present
set GCC=gcc
if exist "S:\mingw32\bin\gcc.exe" set GCC=S:\mingw32\bin\gcc.exe

set OUT=win98-mcp-server.exe
set DEFINES=-DWIN32 -D_WIN32_WINNT=0x0400 -DWIN32_LEAN_AND_MEAN -D_CRT_SECURE_NO_WARNINGS

if "%1"=="DEBUG=1" (
    set CFLAGS=-std=c89 -march=pentium -O0 -g %DEFINES% -Wall -Wno-deprecated-declarations
) else (
    set CFLAGS=-std=c89 -march=pentium -O2 %DEFINES% -Wall -Wno-deprecated-declarations
)

set SRCS=mcp_server.c file_ops.c exec_ops.c ini_ops.c registry_ops.c process_ops.c system_ops.c permissions.c ipc_ops.c cli_mode.c cJSON.c
set LIBS=-lkernel32 -luser32 -lgdi32 -ladvapi32 -lwsock32 -lwinmm

echo.
echo [BUILD] Compiling and linking with MinGW...
echo.

"%GCC%" %CFLAGS% %SRCS% -o %OUT% %LIBS%

if errorlevel 1 (
    echo.
    echo [BUILD] *** Build FAILED ***
    exit /b 1
)

echo.
echo [BUILD] Done: %OUT%
echo.

endlocal
