VERSION 5.00
Object = "{831FDD16-0C5C-11D2-A9FC-0000F8754DA1}#2.0#0"; "MSCOMCTL.OCX"
Begin VB.Form frmMain
   Caption         =   "Win98Botter"
   ClientHeight    =   7800
   ClientLeft      =   60
   ClientTop       =   360
   ClientWidth     =   9600
   Icon            =   "frmMain.frx":0000
   LinkTopic       =   "Form1"
   ScaleHeight     =   7800
   ScaleWidth      =   9600
   StartUpPosition =   2  'CenterScreen

   ' ── Toolbar row ──────────────────────────────────────────────────────────
   Begin VB.CommandButton btnSend
      Caption  =   "&Send"
      Default  =   -1  'True
      Height   =   375
      Left     =   7920
      TabIndex =   0
      Top      =   120
      Width    =   855
   End
   Begin VB.CommandButton btnClear
      Caption  =   "&Clear"
      Height   =   375
      Left     =   6960
      TabIndex =   1
      Top      =   120
      Width    =   855
   End
   Begin VB.CommandButton btnPause
      Caption  =   "Pau&se"
      Height   =   375
      Left     =   6000
      TabIndex =   2
      Top      =   120
      Width    =   855
   End
   Begin VB.CommandButton btnSettings
      Caption  =   "Se&ttings"
      Height   =   375
      Left     =   5040
      TabIndex =   3
      Top      =   120
      Width    =   855
   End
   Begin VB.CommandButton btnAbout
      Caption  =   "A&bout"
      Height   =   375
      Left     =   4080
      TabIndex =   4
      Top      =   120
      Width    =   855
   End

   Begin VB.CommandButton btnStart
      Caption  =   "&Start"
      Height   =   315
      Left     =   120
      TabIndex =   19
      Top      =   600
      Width    =   1455
   End
   Begin VB.CommandButton btnStop
      Caption  =   "S&top"
      Height   =   315
      Left     =   1680
      TabIndex =   20
      Top      =   600
      Width    =   1455
   End
   Begin VB.CommandButton btnInstall
      Caption  =   "&Install"
      Height   =   315
      Left     =   3240
      TabIndex =   21
      Top      =   600
      Width    =   1455
   End
   Begin VB.CommandButton btnUninstall
      Caption  =   "&Uninstall"
      Height   =   315
      Left     =   4800
      TabIndex =   22
      Top      =   600
      Width    =   1455
   End
   Begin VB.CommandButton btnViewLog
      Caption  =   "View &Log"
      Height   =   315
      Left     =   6360
      TabIndex =   23
      Top      =   600
      Width    =   1455
   End
   Begin VB.CommandButton btnHide
      Caption  =   "&Hide"
      Height   =   315
      Left     =   7920
      TabIndex =   24
      Top      =   600
      Width    =   1455
   End

   ' ── Chat history (RichTextBox — read only) ────────────────────────────
   Begin MSComctlLib.RichTextBox rtbHistory
      Height   =   4335
      Left     =   120
      TabIndex =   5
      Top      =   960
      Width    =   9360
      _ExtentX =   16510
      _ExtentY =   8493
      ScrollBars =  2  'Vertical
      Locked     = -1  'True
   End

   ' ── Message input ────────────────────────────────────────────────────
   Begin VB.TextBox txtMessage
      Height   =   855
      Left     =   120
      MultiLine = -1  'True
      TabIndex =   6
      Top      =   5520
      Width    =   9360
   End

   ' ── Permissions frame ────────────────────────────────────────────────
   Begin VB.Frame fraPerms
      Caption  =   "Permissions"
      Height   =   1455
      Left     =   120
      TabIndex =   7
      Top      =   6480
      Width    =   9360

      Begin VB.CheckBox chkReadFile
         Caption  =   "Files (Read)"
         Height   =   255
         Left     =   120
         TabIndex =   8
         Top      =   240
         Width    =   1335
      End
      Begin VB.CheckBox chkWriteFile
         Caption  =   "Files (Write)"
         Height   =   255
         Left     =   1560
         TabIndex =   9
         Top      =   240
         Width    =   1335
      End
      Begin VB.CheckBox chkRunCmd
         Caption  =   "Commands"
         Height   =   255
         Left     =   3000
         TabIndex =   10
         Top      =   240
         Width    =   1335
      End
      Begin VB.CheckBox chkRegistry
         Caption  =   "Registry"
         Height   =   255
         Left     =   4440
         TabIndex =   11
         Top      =   240
         Width    =   1215
      End
      Begin VB.CheckBox chkScheduler
         Caption  =   "Scheduler"
         Height   =   255
         Left     =   5760
         TabIndex =   12
         Top      =   240
         Width    =   1215
      End
      Begin VB.CheckBox chkProcesses
         Caption  =   "Processes"
         Height   =   255
         Left     =   7080
         TabIndex =   13
         Top      =   240
         Width    =   1215
      End
      Begin VB.CheckBox chkPorts
         Caption  =   "I/O Ports"
         Height   =   255
         Left     =   120
         TabIndex =   14
         Top      =   840
         Width    =   1335
      End
      Begin VB.CheckBox chkSerial
         Caption  =   "Serial"
         Height   =   255
         Left     =   1560
         TabIndex =   15
         Top      =   840
         Width    =   1335
      End
      Begin VB.CheckBox chkAudio
         Caption  =   "Audio"
         Height   =   255
         Left     =   3000
         TabIndex =   16
         Top      =   840
         Width    =   1335
      End

      Begin VB.CommandButton btnSavePerms
         Caption  =   "Save"
         Height   =   375
         Left     =   8280
         TabIndex =   17
         Top      =   720
         Width    =   855
      End
   End

   ' ── Status bar ───────────────────────────────────────────────────────
   Begin VB.Label lblStatus
      Alignment =   2  'Center
      BorderStyle =  1  'Fixed Single
      Caption  =   "Status: Disconnected"
      Height   =   255
      Left     =   120
      TabIndex =   18
      Top      =   7680
      Width    =   9360
   End

   ' ── Poll timer ───────────────────────────────────────────────────────
   Begin VB.Timer tmrPoll
      Enabled  =   -1  'True
      Interval =   2000
      Left     =   0
      Top      =   0
   End

End
Attribute VB_Name = "frmMain"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Option Explicit

Private Const APP_SOURCE As String = "user"
Private Const WM_MOUSEMOVE As Long = &H200
Private Const WM_LBUTTONUP As Long = &H202
Private Const WM_LBUTTONDBLCLK As Long = &H203
Private Const WM_RBUTTONUP As Long = &H205
Private Const NIM_ADD As Long = &H0
Private Const NIM_DELETE As Long = &H2
Private Const NIF_MESSAGE As Long = &H1
Private Const NIF_ICON As Long = &H2
Private Const NIF_TIP As Long = &H4

Private Type NOTIFYICONDATA
    cbSize As Long
    hwnd As Long
    uId As Long
    uFlags As Long
    uCallbackMessage As Long
    hIcon As Long
    szTip As String * 64
End Type

Private Declare Function Shell_NotifyIconA Lib "shell32.dll" ( _
    ByVal dwMessage As Long, lpData As NOTIFYICONDATA) As Long

Private m_paused      As Boolean
Private m_sessionId   As String
Private m_lastMsgId   As Long
Private m_agentId     As String
Private m_inTray      As Boolean

' ── Form_Load ────────────────────────────────────────────────────────────────

Private Sub Form_Load()
    m_paused = False
    m_sessionId = ""
    m_lastMsgId = 0
    m_inTray = False

    MCP_EXE = GetMCPExePath()

    LoadPermissions
    UpdatePermCheckboxes

    lblStatus.Caption = "Status: Idle"
    rtbHistory.Text = ""

    ' Try to start MCP server if not running
    If Not IsMCPServerRunning() Then
        StartMCPServer
    End If

    UpdateControlButtons
    UpdateStatus
    If m_agentId = "" Then Call RefreshAgentId
    Call SyncHistory
End Sub

' ── Form_Unload ───────────────────────────────────────────────────────────────

Private Sub Form_Unload(Cancel As Integer)
    tmrPoll.Enabled = False
    RemoveTrayIcon
End Sub

Private Sub Form_Resize()
    If Me.WindowState = vbMinimized Then HideToTray
End Sub

Private Sub Form_MouseMove(Button As Integer, Shift As Integer, X As Single, Y As Single)
    Dim msg As Long
    msg = CLng(X / Screen.TwipsPerPixelX)

    If msg = WM_LBUTTONUP Or msg = WM_LBUTTONDBLCLK Or msg = WM_RBUTTONUP Then
        RestoreFromTray
    End If
End Sub

' ── Send button ───────────────────────────────────────────────────────────────

Private Sub btnSend_Click()
    Dim msg As String
    msg = Trim(txtMessage.Text)
    If Len(msg) = 0 Then Exit Sub

    txtMessage.Text = ""
    lblStatus.Caption = "Status: Sending..."

    Dim reply As String
    Dim finalMsg As String
    If m_sessionId = "" Then
        ' First message — prepend machine context block so the AI knows what it's connecting to
        Dim ctx As String
        ctx = "[Machine:" & Environ("COMPUTERNAME") & _
              " Time:" & Format(Now, "yyyy-MM-dd HH:mm:ss") & _
              " Perms:" & GetActivePermsStr() & "]"
        finalMsg = ctx & vbCrLf & msg
    Else
        finalMsg = msg
    End If
    reply = PostChat(finalMsg, m_sessionId, m_agentId, APP_SOURCE)

    If Left$(reply, 7) = "ERROR: " Then
        AppendChat "Error", reply
        lblStatus.Caption = "Status: Error"
    Else
        If m_sessionId = "" Then
            Dim sid As String
            sid = ExtractJson(reply, "session_id")
            If sid <> "" Then m_sessionId = sid
        End If

        Call SyncHistory
        lblStatus.Caption = "Status: OK"
    End If
End Sub

Private Sub btnStart_Click()
    StartMCPServer
    UpdateControlButtons
    UpdateStatus
End Sub

Private Sub btnStop_Click()
    StopMCPServer
    UpdateControlButtons
    UpdateStatus
End Sub

Private Sub btnInstall_Click()
    InstallMCPServer
    UpdateControlButtons
    lblStatus.Caption = "Status: Installed for auto-start"
End Sub

Private Sub btnUninstall_Click()
    UninstallMCPServer
    UpdateControlButtons
    lblStatus.Caption = "Status: Auto-start removed"
End Sub

Private Sub btnViewLog_Click()
    Dim logText As String
    logText = ReadTailFromFile(GetMCPLogPath(), 4096)
    If Len(logText) = 0 Then
        AppendChat "Local Log", "No agent.log content found yet at " & GetMCPLogPath()
    Else
        AppendChat "Local Log", logText
    End If
End Sub

Private Sub btnHide_Click()
    HideToTray
End Sub

' ── Clear button ─────────────────────────────────────────────────────────────

Private Sub btnClear_Click()
    rtbHistory.Text = ""
    m_sessionId     = ""
    m_lastMsgId     = 0
    m_agentId       = ""
    lblStatus.Caption = "Status: Cleared"
End Sub

' ── Pause / Resume button ─────────────────────────────────────────────────────

Private Sub btnPause_Click()
    If m_paused Then
        PostControl "resume", m_agentId
        m_paused = False
        btnPause.Caption = "Pau&se"
        lblStatus.Caption = "Status: Resumed"
    Else
        PostControl "pause", m_agentId
        m_paused = True
        btnPause.Caption = "&Resume"
        lblStatus.Caption = "Status: Paused"
    End If
End Sub

' ── Settings button ───────────────────────────────────────────────────────────

Private Sub btnSettings_Click()
    frmSettings.Show vbModal
End Sub

' ── About button ──────────────────────────────────────────────────────────────

Private Sub btnAbout_Click()
    frmAbout.Show vbModal
End Sub

' ── Save permissions ──────────────────────────────────────────────────────────

Private Sub btnSavePerms_Click()
    Dim reply As String

    ReadPermCheckboxes
    SavePermissions

    If m_agentId = "" Then Call RefreshAgentId
    reply = PostControlPermissions(m_agentId, PermissionsToJson())

    If Left(reply, 7) = "ERROR: " Then
        lblStatus.Caption = "Status: Permission sync failed"
        AppendChat "Error", reply
    ElseIf InStr(reply, """success"":true") > 0 Or _
           InStr(reply, """success"": true") > 0 Then
        lblStatus.Caption = "Status: Permissions saved and synced"
    Else
        lblStatus.Caption = "Status: Permissions saved locally"
    End If
End Sub

' ── Poll timer ────────────────────────────────────────────────────────────────

Private Sub tmrPoll_Timer()
    UpdateStatus
    SyncHistory
End Sub

' ── Helpers ────────────────────────────────────────────────────────────────────

Private Sub AppendChat(ByVal who As String, ByVal msg As String)
    Dim ts As String
    ts = Format(Now, "hh:mm:ss")
    rtbHistory.SelStart  = Len(rtbHistory.Text)
    rtbHistory.SelLength = 0
    rtbHistory.SelBold   = True
    rtbHistory.SelText   = "[" & ts & "] " & who & ": "
    rtbHistory.SelBold   = False
    rtbHistory.SelText   = msg & vbCrLf & vbCrLf
    ' Scroll to bottom
    rtbHistory.SelStart = Len(rtbHistory.Text)
End Sub

Private Sub UpdateStatus()
    Dim health As String
    health = GetHealth()

    ' Cache agent_id from health response if we don't have it yet
    If m_agentId = "" Then
        Dim aid As String
        aid = ExtractJson(health, "agent_id")
        If aid <> "" Then m_agentId = aid
    End If

    If InStr(health, """relay"":true") > 0 Or InStr(health, """relay"": true") > 0 Then
        If Not m_paused Then
            If InStr(health, """win98_connected"":true") > 0 Or _
               InStr(health, """win98_connected"": true") > 0 Then
                lblStatus.Caption = "Status: Connected"
            Else
                lblStatus.Caption = "Status: Relay OK (agent offline)"
            End If
        End If
    Else
        If Not m_paused Then lblStatus.Caption = "Status: Relay unreachable"
    End If

    UpdateControlButtons
End Sub

Private Sub UpdatePermCheckboxes()
    chkReadFile.Value  = IIf(g_Perms.read_file,   1, 0)
    chkWriteFile.Value = IIf(g_Perms.write_file,  1, 0)
    chkRunCmd.Value    = IIf(g_Perms.run_command, 1, 0)
    chkRegistry.Value  = IIf(g_Perms.read_registry Or g_Perms.write_registry, 1, 0)
    chkScheduler.Value = IIf(g_Perms.scheduler,   1, 0)
    chkProcesses.Value = IIf(g_Perms.list_processes, 1, 0)
    chkPorts.Value     = IIf(g_Perms.read_port,   1, 0)
    chkSerial.Value    = IIf(g_Perms.serial,      1, 0)
    chkAudio.Value     = IIf(g_Perms.audio,       1, 0)
End Sub

Private Sub ReadPermCheckboxes()
    g_Perms.read_file     = (chkReadFile.Value = 1)
    g_Perms.write_file    = (chkWriteFile.Value = 1)
    g_Perms.run_command   = (chkRunCmd.Value = 1)
    g_Perms.read_registry = (chkRegistry.Value = 1)
    g_Perms.write_registry= (chkRegistry.Value = 1)
    g_Perms.scheduler     = (chkScheduler.Value = 1)
    g_Perms.list_processes= (chkProcesses.Value = 1)
    g_Perms.read_port     = (chkPorts.Value = 1)
    g_Perms.serial        = (chkSerial.Value = 1)
    g_Perms.audio         = (chkAudio.Value = 1)
End Sub

' Fetch agent_id from /health and cache it in m_agentId
Private Sub RefreshAgentId()
    Dim h As String
    h = GetHealth()
    Dim id As String
    id = ExtractJson(h, "agent_id")
    If id <> "" Then m_agentId = id
End Sub

Private Sub UpdateControlButtons()
    Dim running As Boolean
    Dim installed As Boolean

    running = IsMCPServerRunning()
    installed = IsMCPServerInstalled()

    btnStart.Enabled = Not running
    btnStop.Enabled = running
    btnInstall.Enabled = Not installed
    btnUninstall.Enabled = installed
    btnViewLog.Enabled = True
End Sub

Private Sub SyncHistory()
    If m_agentId = "" Then Exit Sub

    Dim raw As String
    raw = GetHistory(m_agentId, m_sessionId, APP_SOURCE)
    If Left$(raw, 7) = "ERROR: " Then Exit Sub

    If m_sessionId = "" Then
        Dim sid As String
        sid = ExtractJson(raw, "session_id")
        If sid <> "" Then m_sessionId = sid
    End If

    Call AppendMessagesFromHistory(raw)
End Sub

Private Sub AppendMessagesFromHistory(ByVal json As String)
    Dim p As Long
    Dim msgId As Long
    Dim role As String
    Dim content As String

    p = 1
    Do
        p = InStr(p, json, """id"":")
        If p = 0 Then Exit Do

        msgId = Val(ReadScalarAt(json, p + 5))
        role = LCase$(ExtractJsonAt(json, "role", p))
        content = JsonUnescape(ExtractJsonAt(json, "content", p))

        If msgId > m_lastMsgId Then
            If role = "user" Then
                AppendChat "You", CleanupDisplayedMessage(content)
            ElseIf role = "assistant" Then
                AppendChat "Assistant", content
            ElseIf role = "system" Then
                AppendChat "System", content
            End If
            m_lastMsgId = msgId
        End If

        p = p + 5
    Loop
End Sub

Private Function CleanupDisplayedMessage(ByVal text As String) As String
    Dim marker As String
    marker = "]"
    If Left$(text, 9) = "[Machine:" Then
        Dim p As Long
        p = InStr(text, marker)
        If p > 0 Then
            text = Trim$(Mid$(text, p + 1))
        End If
    End If
    CleanupDisplayedMessage = text
End Function

Private Function ReadScalarAt(ByVal json As String, ByVal p As Long) As String
    Dim q As Long
    q = p
    Do While q <= Len(json)
        Dim c As String
        c = Mid$(json, q, 1)
        If c = "," Or c = "}" Or c = "]" Then Exit Do
        q = q + 1
    Loop
    ReadScalarAt = Trim$(Mid$(json, p, q - p))
End Function

Private Function ExtractJsonAt(ByVal json As String, ByVal key As String, ByVal startPos As Long) As String
    Dim kq As String, p As Long, q As Long
    kq = """" & key & """:"
    p = InStr(startPos, json, kq)
    If p = 0 Then ExtractJsonAt = "": Exit Function
    p = p + Len(kq)
    Do While Mid$(json, p, 1) = " " Or Mid$(json, p, 1) = Chr$(9)
        p = p + 1
    Loop
    If Mid$(json, p, 1) = """" Then
        p = p + 1
        q = p
        Do While q <= Len(json)
            If Mid$(json, q, 1) = """" And Mid$(json, q - 1, 1) <> "\" Then Exit Do
            q = q + 1
        Loop
        If q > Len(json) Then ExtractJsonAt = "": Exit Function
        ExtractJsonAt = Mid$(json, p, q - p)
    Else
        ExtractJsonAt = ReadScalarAt(json, p)
    End If
End Function

Private Function JsonUnescape(ByVal text As String) As String
    Dim s As String
    s = text
    s = Replace(s, "\n", vbCrLf)
    s = Replace(s, "\r", "")
    s = Replace(s, "\t", vbTab)
    s = Replace(s, Chr$(92) & Chr$(34), Chr$(34))
    s = Replace(s, Chr$(92) & Chr$(92), Chr$(92))
    JsonUnescape = s
End Function

Private Function ReadTailFromFile(ByVal filePath As String, ByVal maxChars As Long) As String
    On Error Resume Next
    Dim ff As Integer
    Dim content As String
    ff = FreeFile
    Open filePath For Input As #ff
    content = Input$(LOF(ff), #ff)
    Close #ff
    If Len(content) > maxChars Then
        ReadTailFromFile = Right$(content, maxChars)
    Else
        ReadTailFromFile = content
    End If
    On Error GoTo 0
End Function

Private Sub HideToTray()
    Dim nid As NOTIFYICONDATA
    If m_inTray Then
        Me.Hide
        Exit Sub
    End If

    nid.cbSize = Len(nid)
    nid.hwnd = Me.hwnd
    nid.uId = 1
    nid.uFlags = NIF_ICON Or NIF_TIP Or NIF_MESSAGE
    nid.uCallbackMessage = WM_MOUSEMOVE
    nid.hIcon = Me.Icon.Handle
    nid.szTip = "Win98Botter" & Chr$(0)
    Call Shell_NotifyIconA(NIM_ADD, nid)

    m_inTray = True
    Me.Hide
    lblStatus.Caption = "Status: Running in background"
End Sub

Private Sub RestoreFromTray()
    If Not m_inTray Then Exit Sub
    RemoveTrayIcon
    Me.Show
    Me.WindowState = vbNormal
    Me.SetFocus
End Sub

Private Sub RemoveTrayIcon()
    If Not m_inTray Then Exit Sub
    Dim nid As NOTIFYICONDATA
    nid.cbSize = Len(nid)
    nid.hwnd = Me.hwnd
    nid.uId = 1
    Call Shell_NotifyIconA(NIM_DELETE, nid)
    m_inTray = False
End Sub

' Build comma-separated list of currently-enabled permission categories
Private Function GetActivePermsStr() As String
    Dim parts As String
    parts = ""
    If g_Perms.read_file      Then parts = parts & "file_read,"
    If g_Perms.write_file     Then parts = parts & "file_write,"
    If g_Perms.delete_file    Then parts = parts & "file_delete,"
    If g_Perms.read_registry  Then parts = parts & "registry_read,"
    If g_Perms.write_registry Then parts = parts & "registry_write,"
    If g_Perms.run_command    Then parts = parts & "execute,"
    If g_Perms.list_processes Then parts = parts & "process_list,"
    If g_Perms.kill_process   Then parts = parts & "process_kill,"
    If g_Perms.serial         Then parts = parts & "serial,"
    If g_Perms.scheduler      Then parts = parts & "scheduler,"
    If g_Perms.read_port      Then parts = parts & "hardware_io,"
    If Len(parts) > 0 Then parts = Left(parts, Len(parts) - 1)
    GetActivePermsStr = parts
End Function

' Primitive JSON field extractor (no full parser needed for simple responses)
Private Function ExtractJson(ByVal json As String, ByVal key As String) As String
    Dim kq As String, p As Long, q As Long
    kq = """" & key & """:"
    p = InStr(json, kq)
    If p = 0 Then ExtractJson = "": Exit Function
    p = p + Len(kq)
    ' Skip whitespace
    Do While Mid(json, p, 1) = " " Or Mid(json, p, 1) = Chr(9)
        p = p + 1
    Loop
    If Mid(json, p, 1) = """" Then
        ' String value
        p = p + 1
        q = InStr(p, json, """")
        If q = 0 Then ExtractJson = "": Exit Function
        ExtractJson = Mid(json, p, q - p)
    Else
        ' Number or bool — read to next , or }
        q = p
        Do While q <= Len(json)
            Dim c As String
            c = Mid(json, q, 1)
            If c = "," Or c = "}" Or c = "]" Then Exit Do
            q = q + 1
        Loop
        ExtractJson = Trim(Mid(json, p, q - p))
    End If
End Function
