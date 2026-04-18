Attribute VB_Name = "modProcess"
Option Explicit

' ── Win32 declarations ────────────────────────────────────────────────────────

Private Type STARTUPINFO
    cb               As Long
    lpReserved       As String
    lpDesktop        As String
    lpTitle          As String
    dwX              As Long
    dwY              As Long
    dwXSize          As Long
    dwYSize          As Long
    dwXCountChars    As Long
    dwYCountChars    As Long
    dwFillAttribute  As Long
    dwFlags          As Long
    wShowWindow      As Integer
    cbReserved2      As Integer
    lpReserved2      As Long
    hStdInput        As Long
    hStdOutput       As Long
    hStdError        As Long
End Type

Private Type PROCESS_INFORMATION
    hProcess    As Long
    hThread     As Long
    dwProcessId As Long
    dwThreadId  As Long
End Type

Private Declare Function CreateProcessA Lib "kernel32" ( _
    ByVal lpApplicationName As String, _
    ByVal lpCommandLine As String, _
    ByVal lpProcessAttributes As Long, _
    ByVal lpThreadAttributes As Long, _
    ByVal bInheritHandles As Long, _
    ByVal dwCreationFlags As Long, _
    ByVal lpEnvironment As Long, _
    ByVal lpCurrentDirectory As String, _
    lpStartupInfo As STARTUPINFO, _
    lpProcessInformation As PROCESS_INFORMATION) As Long

Private Declare Function OpenProcess Lib "kernel32" ( _
    ByVal dwDesiredAccess As Long, _
    ByVal bInheritHandle As Long, _
    ByVal dwProcessId As Long) As Long

Private Declare Function GetExitCodeProcess Lib "kernel32" ( _
    ByVal hProcess As Long, lpExitCode As Long) As Long

Private Declare Function WaitForSingleObject Lib "kernel32" ( _
    ByVal hHandle As Long, ByVal dwMilliseconds As Long) As Long

Private Declare Sub CloseHandle Lib "kernel32" (ByVal hObject As Long)

Private Declare Function RegOpenKeyExA Lib "advapi32.dll" ( _
    ByVal hKey As Long, ByVal lpSubKey As String, ByVal ulOptions As Long, _
    ByVal samDesired As Long, phkResult As Long) As Long

Private Declare Function RegQueryValueExA Lib "advapi32.dll" ( _
    ByVal hKey As Long, ByVal lpValueName As String, ByVal lpReserved As Long, _
    lpType As Long, ByVal lpData As String, lpcbData As Long) As Long

Private Declare Function RegCloseKey Lib "advapi32.dll" ( _
    ByVal hKey As Long) As Long

Private Const PROCESS_TERMINATE    As Long = &H1
Private Const PROCESS_QUERY_INFORMATION As Long = &H400
Private Const STILL_ACTIVE         As Long = 259
Private Const CREATE_NO_WINDOW     As Long = &H8000000
Private Const NORMAL_PRIORITY_CLASS As Long = &H20
Private Const WAIT_OBJECT_0        As Long = 0
Private Const HKEY_LOCAL_MACHINE   As Long = &H80000002
Private Const KEY_QUERY_VALUE      As Long = &H1

Private Declare Function TerminateProcess Lib "kernel32" ( _
    ByVal hProcess As Long, ByVal uExitCode As Long) As Long

' Path to the MCP server executable
' (overwritten by frmSettings / agent_gui.ini)
Public MCP_EXE As String
Private Const DEFAULT_MCP_DIR As String = "C:\WIN98BOTTER"
Private Const DEFAULT_MCP_EXE As String = "C:\WIN98BOTTER\win98-mcp-server.exe"
Private Const DEFAULT_MCP_EXE_LEGACY As String = "C:\WIN98BOTTER\mcp_server.exe"

Private g_MCPHandle As Long   ' hProcess of running MCP server, or 0
Private g_MCPPID    As Long   ' PID of running MCP server, or 0

' ── StartMCPServer ─────────────────────────────────────────────────────────────

Public Function GetMCPExePath() As String
    Dim exe As String
    exe = ResolveMCPExePath()
    MCP_EXE = exe
    GetMCPExePath = exe
End Function

Public Function GetMCPLogPath() As String
    Dim exe As String
    Dim folder As String
    exe = ResolveMCPExePath()
    folder = ExtractFolder(exe)
    If Len(folder) = 0 Then folder = DEFAULT_MCP_DIR
    GetMCPLogPath = folder & "\agent.log"
End Function

Public Function IsMCPServerInstalled() As Boolean
    Dim hKey As Long
    Dim rc As Long
    Dim valueType As Long
    Dim buf As String
    Dim bufLen As Long

    rc = RegOpenKeyExA(HKEY_LOCAL_MACHINE, _
        "SOFTWARE\Microsoft\Windows\CurrentVersion\Run", _
        0, KEY_QUERY_VALUE, hKey)
    If rc <> 0 Then
        IsMCPServerInstalled = False
        Exit Function
    End If

    buf = Space$(512)
    bufLen = Len(buf)
    rc = RegQueryValueExA(hKey, "Win98MCPServer", 0, valueType, buf, bufLen)
    RegCloseKey hKey
    IsMCPServerInstalled = (rc = 0)
End Function

Public Sub StartMCPServer()
    Dim exe As String
    Dim cmdLine As String
    Dim workDir As String

    If IsMCPServerRunning() Then Exit Sub

    exe = ResolveMCPExePath()
    If Not FileExists(exe) Then
        MsgBox "MCP server not found at:" & vbCrLf & exe & vbCrLf & _
               "Set the full path in Settings or place the EXE beside the VB6 app.", _
               vbExclamation
        Exit Sub
    End If

    workDir = ExtractFolder(exe)
    If Len(workDir) = 0 Then workDir = DEFAULT_MCP_DIR
    cmdLine = QuoteArg(exe)

    Dim si   As STARTUPINFO
    Dim pi   As PROCESS_INFORMATION
    si.cb = Len(si)
    si.dwFlags = 0
    si.wShowWindow = 1

    Dim ok As Long
    ok = CreateProcessA(vbNullString, cmdLine, 0, 0, 0, _
                        NORMAL_PRIORITY_CLASS, 0, workDir, si, pi)
    If ok = 0 Then
        MsgBox "Failed to start MCP server.", vbCritical
        Exit Sub
    End If

    g_MCPHandle = pi.hProcess
    g_MCPPID = pi.dwProcessId
    CloseHandle pi.hThread
End Sub

' ── StopMCPServer ─────────────────────────────────────────────────────────────

Public Sub StopMCPServer()
    Call RunMCPCommand("-stop", 3000, True)

    If g_MCPHandle <> 0 Then
        TerminateProcess g_MCPHandle, 0
        CloseHandle g_MCPHandle
        g_MCPHandle = 0
        g_MCPPID = 0
    End If
End Sub

Public Sub InstallMCPServer()
    Call RunMCPCommand("-install", 5000, True)
End Sub

Public Sub UninstallMCPServer()
    Call RunMCPCommand("-uninstall", 5000, True)

    If g_MCPHandle <> 0 Then
        CloseHandle g_MCPHandle
        g_MCPHandle = 0
        g_MCPPID = 0
    End If
End Sub

' ── IsMCPServerRunning ────────────────────────────────────────────────────────

Public Function IsMCPServerRunning() As Boolean
    If g_MCPHandle = 0 Then
        IsMCPServerRunning = False
        Exit Function
    End If

    Dim exitCode As Long
    GetExitCodeProcess g_MCPHandle, exitCode
    If exitCode = STILL_ACTIVE Then
        IsMCPServerRunning = True
    Else
        ' Process has exited; clean up handle
        CloseHandle g_MCPHandle
        g_MCPHandle = 0
        g_MCPPID    = 0
        IsMCPServerRunning = False
    End If
End Function

' ── Helpers ───────────────────────────────────────────────────────────────────

Private Function ResolveMCPExePath() As String
    Dim candidate As String

    candidate = Trim$(MCP_EXE)
    If FileExists(candidate) Then ResolveMCPExePath = candidate: Exit Function

    candidate = NormalizePath(App.Path) & "\win98-mcp-server.exe"
    If FileExists(candidate) Then ResolveMCPExePath = candidate: Exit Function

    candidate = NormalizePath(App.Path) & "\mcp_server.exe"
    If FileExists(candidate) Then ResolveMCPExePath = candidate: Exit Function

    If FileExists(DEFAULT_MCP_EXE) Then ResolveMCPExePath = DEFAULT_MCP_EXE: Exit Function
    If FileExists(DEFAULT_MCP_EXE_LEGACY) Then ResolveMCPExePath = DEFAULT_MCP_EXE_LEGACY: Exit Function

    If Len(Trim$(MCP_EXE)) > 0 Then
        ResolveMCPExePath = Trim$(MCP_EXE)
    Else
        ResolveMCPExePath = DEFAULT_MCP_EXE
    End If
End Function

Private Function RunMCPCommand(ByVal args As String, _
                               Optional ByVal waitMs As Long = 3000, _
                               Optional ByVal showWindow As Boolean = True) As Boolean
    Dim exe As String
    Dim cmdLine As String
    Dim workDir As String
    Dim flags As Long
    Dim si As STARTUPINFO
    Dim pi As PROCESS_INFORMATION
    Dim ok As Long

    exe = ResolveMCPExePath()
    If Not FileExists(exe) Then
        MsgBox "MCP server not found at:" & vbCrLf & exe, vbExclamation
        Exit Function
    End If

    workDir = ExtractFolder(exe)
    If Len(workDir) = 0 Then workDir = DEFAULT_MCP_DIR
    cmdLine = QuoteArg(exe) & " " & Trim$(args)
    flags = NORMAL_PRIORITY_CLASS
    If Not showWindow Then flags = flags Or CREATE_NO_WINDOW

    si.cb = Len(si)
    si.dwFlags = 0
    si.wShowWindow = IIf(showWindow, 1, 0)

    ok = CreateProcessA(vbNullString, cmdLine, 0, 0, 0, flags, 0, workDir, si, pi)
    If ok = 0 Then
        MsgBox "Failed to run command:" & vbCrLf & cmdLine, vbCritical
        Exit Function
    End If

    If waitMs > 0 Then Call WaitForSingleObject(pi.hProcess, waitMs)
    CloseHandle pi.hThread
    CloseHandle pi.hProcess
    RunMCPCommand = True
End Function

Private Function QuoteArg(ByVal value As String) As String
    QuoteArg = Chr$(34) & value & Chr$(34)
End Function

Private Function ExtractFolder(ByVal fullPath As String) As String
    Dim p As Long
    p = InStrRev(fullPath, "\")
    If p > 0 Then
        ExtractFolder = Left$(fullPath, p - 1)
    Else
        ExtractFolder = ""
    End If
End Function

Private Function NormalizePath(ByVal path As String) As String
    NormalizePath = path
    If Right$(NormalizePath, 1) = "\" Then
        NormalizePath = Left$(NormalizePath, Len(NormalizePath) - 1)
    End If
End Function

Private Function FileExists(ByVal path As String) As Boolean
    On Error Resume Next
    If Len(Trim$(path)) = 0 Then
        FileExists = False
    Else
        FileExists = (GetAttr(path) And vbDirectory) = 0
    End If
    On Error GoTo 0
End Function
