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

Private Declare Sub CloseHandle Lib "kernel32" (ByVal hObject As Long)

Private Const PROCESS_TERMINATE    As Long = &H1
Private Const PROCESS_QUERY_INFORMATION As Long = &H400
Private Const STILL_ACTIVE         As Long = 259
Private Const CREATE_NO_WINDOW     As Long = &H8000000
Private Const NORMAL_PRIORITY_CLASS As Long = &H20

Private Declare Function TerminateProcess Lib "kernel32" ( _
    ByVal hProcess As Long, ByVal uExitCode As Long) As Long

' Path to the MCP server executable
' (overwritten by frmSettings / agent_gui.ini)
Public MCP_EXE As String
Private Const DEFAULT_MCP_EXE As String = "C:\WIN98BOTTER\win98-mcp-server.exe"

Private g_MCPHandle As Long   ' hProcess of running MCP server, or 0
Private g_MCPPID    As Long   ' PID of running MCP server, or 0

' ── StartMCPServer ─────────────────────────────────────────────────────────────

Public Sub StartMCPServer()
    Dim exe As String
    exe = MCP_EXE
    If Len(Trim(exe)) = 0 Then exe = DEFAULT_MCP_EXE

    If Not FileExists(exe) Then
        MsgBox "MCP server not found at:" & vbCrLf & exe & vbCrLf & _
               "Build win98-mcp-server.exe first and place it at that path.", _
               vbExclamation
        Exit Sub
    End If

    Dim si   As STARTUPINFO
    Dim pi   As PROCESS_INFORMATION
    si.cb         = Len(si)
    si.dwFlags    = 0
    si.wShowWindow = 1  ' SW_NORMAL — show console window

    Dim ok As Long
    ok = CreateProcessA(vbNullString, exe, 0, 0, 0, _
                        NORMAL_PRIORITY_CLASS, 0, "C:\WIN98BOTTER", si, pi)
    If ok = 0 Then
        MsgBox "Failed to start MCP server.", vbCritical
        Exit Sub
    End If

    g_MCPHandle = pi.hProcess
    g_MCPPID    = pi.dwProcessId
    CloseHandle pi.hThread
End Sub

' ── StopMCPServer ─────────────────────────────────────────────────────────────

Public Sub StopMCPServer()
    If g_MCPHandle = 0 Then Exit Sub
    TerminateProcess g_MCPHandle, 0
    CloseHandle g_MCPHandle
    g_MCPHandle = 0
    g_MCPPID    = 0
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

' ── FileExists helper ─────────────────────────────────────────────────────────

Private Function FileExists(ByVal path As String) As Boolean
    On Error Resume Next
    FileExists = (GetAttr(path) And vbDirectory) = 0
    On Error GoTo 0
End Function
