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

   ' ── Chat history (RichTextBox — read only) ────────────────────────────
   Begin MSComctlLib.RichTextBox rtbHistory
      Height   =   4815
      Left     =   120
      TabIndex =   5
      Top      =   600
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

Private m_paused      As Boolean
Private m_sessionId   As String
Private m_lastMsgId   As Long
Private m_agentId     As String

' ── Form_Load ────────────────────────────────────────────────────────────────

Private Sub Form_Load()
    m_paused    = False
    m_sessionId = ""
    m_lastMsgId = 0

    LoadPermissions
    UpdatePermCheckboxes

    lblStatus.Caption = "Status: Idle"
    rtbHistory.Text   = ""

    ' Try to start MCP server if not running
    If Not IsMCPServerRunning() Then
        StartMCPServer
    End If

    UpdateStatus
    If m_agentId = "" Then Call RefreshAgentId
End Sub

' ── Form_Unload ───────────────────────────────────────────────────────────────

Private Sub Form_Unload(Cancel As Integer)
    tmrPoll.Enabled = False
End Sub

' ── Send button ───────────────────────────────────────────────────────────────

Private Sub btnSend_Click()
    Dim msg As String
    msg = Trim(txtMessage.Text)
    If Len(msg) = 0 Then Exit Sub

    AppendChat "You", msg
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
    reply = PostChat(finalMsg, m_sessionId, m_agentId)

    If Left(reply, 7) = "ERROR: " Then
        AppendChat "Error", reply
        lblStatus.Caption = "Status: Error"
    Else
        ' Extract session_id from first response if not set
        If m_sessionId = "" Then
            Dim sid As String
            sid = ExtractJson(reply, "session_id")
            If sid <> "" Then m_sessionId = sid
        End If

        Dim txt As String
        txt = ExtractJson(reply, "response")
        If txt = "" Then txt = reply
        AppendChat "Assistant", txt
        lblStatus.Caption = "Status: OK"
    End If
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
        PostControl "resume"
        m_paused = False
        btnPause.Caption = "Pau&se"
        lblStatus.Caption = "Status: Resumed"
    Else
        PostControl "pause"
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
    ReadPermCheckboxes
    SavePermissions
    lblStatus.Caption = "Status: Permissions saved"
End Sub

' ── Poll timer ────────────────────────────────────────────────────────────────

Private Sub tmrPoll_Timer()
    UpdateStatus
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
        If Not m_paused Then
            lblStatus.Caption = "Status: Relay unreachable"
        End If
    End If
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
