@echo off
rem Run from this source directory after calling VC98\BIN\VCVARS32.BAT.
rem COMMAND.COM-compatible: no SETLOCAL, command blocks or EXIT /B.
rem Fresh directory required. Never overwrite an earlier candidate.
if exist MCP015.EXE goto occupied
if exist BUILD98.LOG goto occupied
echo COMPILE_STARTED > BUILD98.LOG
cl.exe @VC6.RSP > COMPILE.LOG
if errorlevel 1 goto failed
echo LINK_STARTED >> BUILD98.LOG
link.exe @LINK98.RSP > LINK.LOG
if errorlevel 1 goto failed
if not exist MCP015.EXE goto failed
MCP015.EXE -version > VERSION.LOG
if errorlevel 1 goto failed
echo BUILD_OK >> BUILD98.LOG
goto end
:failed
echo BUILD_FAILED >> BUILD98.LOG
echo Build failed. Do not promote any output executable.
goto end
:occupied
echo Existing build preserved. Use a fresh build directory.
:end
