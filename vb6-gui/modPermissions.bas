Attribute VB_Name = "modPermissions"
Option Explicit

' ── Permissions structure ──────────────────────────────────────────────────────
'
' Mirrors permissions.ini [tools] section that the C agent reads.
' Stored in C:\WIN98BOTTER\permissions.ini

Public Type PermissionsType
    read_file       As Boolean
    write_file      As Boolean
    delete_file     As Boolean
    list_processes  As Boolean
    kill_process    As Boolean
    run_command     As Boolean
    read_registry   As Boolean
    write_registry  As Boolean
    read_port       As Boolean
    write_port      As Boolean
    load_vxd        As Boolean
    modify_sysconfig As Boolean
    serial          As Boolean
    scheduler       As Boolean
    audio           As Boolean
    display         As Boolean
End Type

Public g_Perms As PermissionsType

Private Const PERMS_INI  As String = "C:\WIN98BOTTER\permissions.ini"
Private Const PERMS_SEC  As String = "tools"

' Win32 INI API
Private Declare Function GetPrivateProfileStringA Lib "kernel32" ( _
    ByVal lpAppName As String, ByVal lpKeyName As String, _
    ByVal lpDefault As String, ByVal lpReturnedString As String, _
    ByVal nSize As Long, ByVal lpFileName As String) As Long

Private Declare Function WritePrivateProfileStringA Lib "kernel32" ( _
    ByVal lpAppName As String, ByVal lpKeyName As String, _
    ByVal lpString As String, ByVal lpFileName As String) As Long

' ── LoadPermissions ────────────────────────────────────────────────────────────

Public Sub LoadPermissions()
    g_Perms.read_file        = ReadBool("read_file",        False)
    g_Perms.write_file       = ReadBool("write_file",       False)
    g_Perms.delete_file      = ReadBool("delete_file",      False)
    g_Perms.list_processes   = ReadBool("list_processes",   False)
    g_Perms.kill_process     = ReadBool("kill_process",     False)
    g_Perms.run_command      = ReadBool("run_command",      False)
    g_Perms.read_registry    = ReadBool("read_registry",    False)
    g_Perms.write_registry   = ReadBool("write_registry",   False)
    g_Perms.read_port        = ReadBool("read_port",        False)
    g_Perms.write_port       = ReadBool("write_port",       False)
    g_Perms.load_vxd         = ReadBool("load_vxd",        False)
    g_Perms.modify_sysconfig = ReadBool("modify_sysconfig", False)
    g_Perms.serial           = ReadBool("serial",           False)
    g_Perms.scheduler        = ReadBool("scheduler",        False)
    g_Perms.audio            = ReadBool("audio",            True)
    g_Perms.display          = ReadBool("display",          True)
End Sub

' ── SavePermissions ────────────────────────────────────────────────────────────

Public Sub SavePermissions()
    WriteBool "read_file",        g_Perms.read_file
    WriteBool "write_file",       g_Perms.write_file
    WriteBool "delete_file",      g_Perms.delete_file
    WriteBool "list_processes",   g_Perms.list_processes
    WriteBool "kill_process",     g_Perms.kill_process
    WriteBool "run_command",      g_Perms.run_command
    WriteBool "read_registry",    g_Perms.read_registry
    WriteBool "write_registry",   g_Perms.write_registry
    WriteBool "read_port",        g_Perms.read_port
    WriteBool "write_port",       g_Perms.write_port
    WriteBool "load_vxd",         g_Perms.load_vxd
    WriteBool "modify_sysconfig", g_Perms.modify_sysconfig
    WriteBool "serial",           g_Perms.serial
    WriteBool "scheduler",        g_Perms.scheduler
    WriteBool "audio",            g_Perms.audio
    WriteBool "display",          g_Perms.display
End Sub

Public Function PermissionsToJson() As String
    Dim s As String
    s = "{"
    s = s & """read_file"":" & BoolJson(g_Perms.read_file)
    s = s & ",""write_file"":" & BoolJson(g_Perms.write_file)
    s = s & ",""delete_file"":" & BoolJson(g_Perms.delete_file)
    s = s & ",""list_processes"":" & BoolJson(g_Perms.list_processes)
    s = s & ",""kill_process"":" & BoolJson(g_Perms.kill_process)
    s = s & ",""run_command"":" & BoolJson(g_Perms.run_command)
    s = s & ",""read_registry"":" & BoolJson(g_Perms.read_registry)
    s = s & ",""write_registry"":" & BoolJson(g_Perms.write_registry)
    s = s & ",""read_port"":" & BoolJson(g_Perms.read_port)
    s = s & ",""write_port"":" & BoolJson(g_Perms.write_port)
    s = s & ",""load_vxd"":" & BoolJson(g_Perms.load_vxd)
    s = s & ",""modify_sysconfig"":" & BoolJson(g_Perms.modify_sysconfig)
    s = s & ",""serial"":" & BoolJson(g_Perms.serial)
    s = s & ",""scheduler"":" & BoolJson(g_Perms.scheduler)
    s = s & ",""audio"":" & BoolJson(g_Perms.audio)
    s = s & ",""display"":" & BoolJson(g_Perms.display)
    s = s & "}"
    PermissionsToJson = s
End Function

' ── Private helpers ────────────────────────────────────────────────────────────

Private Function ReadBool(ByVal key As String, ByVal def As Boolean) As Boolean
    Dim buf As String * 8
    Dim ret As Long
    Dim defStr As String
    defStr = IIf(def, "1", "0")
    ret = GetPrivateProfileStringA(PERMS_SEC, key, defStr, buf, 8, PERMS_INI)
    ReadBool = (Left(buf, ret) = "1")
End Function

Private Sub WriteBool(ByVal key As String, ByVal val As Boolean)
    WritePrivateProfileStringA PERMS_SEC, key, IIf(val, "1", "0"), PERMS_INI
End Sub

Private Function BoolJson(ByVal val As Boolean) As String
    If val Then
        BoolJson = "true"
    Else
        BoolJson = "false"
    End If
End Function
