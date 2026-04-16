VERSION 5.00
Begin VB.Form frmSettings
   Caption         =   "Settings"
   ClientHeight    =   3120
   ClientLeft      =   60
   ClientTop       =   360
   ClientWidth     =   5760
   StartUpPosition =   2  'CenterScreen

   Begin VB.Label lblRelayHost
      Caption  =   "Relay Host:"
      Height   =   255
      Left     =   240
      Top      =   240
      Width    =   1215
   End
   Begin VB.TextBox txtRelayHost
      Height   =   375
      Left     =   1560
      TabIndex =   0
      Top      =   240
      Width    =   3840
   End

   Begin VB.Label lblRelayPort
      Caption  =   "Relay Port:"
      Height   =   255
      Left     =   240
      Top      =   720
      Width    =   1215
   End
   Begin VB.TextBox txtRelayPort
      Height   =   375
      Left     =   1560
      TabIndex =   1
      Top      =   720
      Width    =   1215
   End

   Begin VB.Label lblMCPPath
      Caption  =   "MCP exe:"
      Height   =   255
      Left     =   240
      Top      =   1200
      Width    =   1215
   End
   Begin VB.TextBox txtMCPPath
      Height   =   375
      Left     =   1560
      TabIndex =   2
      Top      =   1200
      Width    =   3840
   End

   Begin VB.CommandButton btnTestConn
      Caption  =   "Test Connection"
      Height   =   375
      Left     =   240
      TabIndex =   3
      Top      =   1800
      Width    =   1815
   End

   Begin VB.Label lblTestResult
      BorderStyle =   1  'Fixed Single
      Caption  =   ""
      Height   =   375
      Left     =   2160
      TabIndex =   4
      Top      =   1800
      Width    =   3240
   End

   Begin VB.CommandButton btnOK
      Caption  =   "OK"
      Default  =   -1  'True
      Height   =   375
      Left     =   3960
      TabIndex =   5
      Top      =   2520
      Width    =   855
   End
   Begin VB.CommandButton btnCancel
      Cancel   =   -1  'True
      Caption  =   "Cancel"
      Height   =   375
      Left     =   4920
      TabIndex =   6
      Top      =   2520
      Width    =   855
   End
   Begin VB.CommandButton btnBrowse
      Caption  =   "..."
      Height   =   375
      Left     =   5520
      TabIndex =   7
      Top      =   1200
      Width    =   375
   End
End
Attribute VB_Name = "frmSettings"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Option Explicit

Private Const INI_PATH As String = "C:\WIN98BOTTER\agent_gui.ini"

Private Sub Form_Load()
    Dim host As String, port As String, mcp As String
    host = GetIni("gui", "relay_host", "127.0.0.1")
   port = GetIni("gui", "relay_port", "3000")
    mcp  = GetIni("gui", "mcp_exe",   "C:\WIN98BOTTER\win98-mcp-server.exe")
    txtRelayHost.Text = host
    txtRelayPort.Text = port
    txtMCPPath.Text   = mcp

    ' Update the global constants used by modHTTP
    RELAY_HOST = host
    RELAY_PORT = CInt(port)
End Sub

Private Sub btnTestConn_Click()
    lblTestResult.Caption = "Testing..."
    DoEvents
    Dim result As String
    result = GetHealth()
    If InStr(result, "ok") > 0 Then
        lblTestResult.Caption = "Connected OK"
    Else
        lblTestResult.Caption = "FAILED: " & Left(result, 40)
    End If
End Sub

Private Sub btnBrowse_Click()
    ' Simple CommonDialog fallback using Shell open dialog
    ' (VB6 projects using COMDLG32.OCX would use CommonDialog here;
    '  we avoid the dependency and just ask the user to type the path)
    MsgBox "Type the full path to win98-mcp-server.exe in the MCP exe field.", vbInformation
End Sub

Private Sub btnOK_Click()
    Dim host As String, port As String, mcp As String
    host = Trim(txtRelayHost.Text)
    port = Trim(txtRelayPort.Text)
    mcp  = Trim(txtMCPPath.Text)

    If Len(host) = 0 Then MsgBox "Host cannot be blank.": Exit Sub
    If Not IsNumeric(port) Then MsgBox "Port must be a number.": Exit Sub
    If CInt(port) < 1 Or CInt(port) > 65535 Then MsgBox "Port must be 1-65535.": Exit Sub

    WriteIni "gui", "relay_host", host, INI_PATH
    WriteIni "gui", "relay_port", port, INI_PATH
    WriteIni "gui", "mcp_exe",    mcp,  INI_PATH

    RELAY_HOST = host
    RELAY_PORT = CInt(port)
    MCP_EXE    = mcp

    Unload Me
End Sub

Private Sub btnCancel_Click()
    Unload Me
End Sub

' Minimal INI helpers (use Win32 API via modPermissions indirection)
Private Function GetIni(sec As String, key As String, def As String) As String
    Dim buf As String * 256
    Dim ret As Long
    ret = GetPrivateProfileStringA(sec, key, def, buf, 256, INI_PATH)
    GetIni = Left(buf, ret)
End Function

Private Sub WriteIni(sec As String, key As String, val As String, path As String)
    WritePrivateProfileStringA sec, key, val, path
End Sub

' Win32 declarations local to this form
Private Declare Function GetPrivateProfileStringA Lib "kernel32" ( _
    ByVal lpAppName As String, ByVal lpKeyName As String, _
    ByVal lpDefault As String, ByVal lpReturnedString As String, _
    ByVal nSize As Long, ByVal lpFileName As String) As Long

Private Declare Function WritePrivateProfileStringA Lib "kernel32" ( _
    ByVal lpAppName As String, ByVal lpKeyName As String, _
    ByVal lpString As String, ByVal lpFileName As String) As Long
