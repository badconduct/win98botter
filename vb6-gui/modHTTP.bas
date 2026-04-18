Attribute VB_Name = "modHTTP"
Option Explicit

' ── Configuration (mutable — updated from frmSettings) ───────────────────────

Public RELAY_HOST As String
Public RELAY_PORT As Integer
Public MCP_EXE    As String

' Defaults — overridden by frmSettings / agent_gui.ini on startup
Private Const DEFAULT_HOST As String  = "127.0.0.1"
Private Const DEFAULT_PORT As Integer = 3000

Private Sub InitDefaults()
    If Len(RELAY_HOST) = 0 Then RELAY_HOST = DEFAULT_HOST
    If RELAY_PORT = 0      Then RELAY_PORT = DEFAULT_PORT
End Sub

' ── Win32 WinINet declarations ────────────────────────────────────────────────

Private Const INTERNET_OPEN_TYPE_PRECONFIG  As Long = 0
Private Const INTERNET_SERVICE_HTTP         As Long = 3
Private Const INTERNET_FLAG_RELOAD          As Long = &H80000000
Private Const HTTP_QUERY_STATUS_CODE        As Long = 19
Private Const INTERNET_FLAG_NO_CACHE_WRITE  As Long = &H4000000

Private Declare Function InternetOpenA Lib "wininet.dll" ( _
    ByVal lpszAgent As String, ByVal dwAccessType As Long, _
    ByVal lpszProxy As String, ByVal lpszProxyBypass As String, _
    ByVal dwFlags As Long) As Long

Private Declare Function InternetConnectA Lib "wininet.dll" ( _
    ByVal hInternet As Long, ByVal lpszServerName As String, _
    ByVal nServerPort As Integer, ByVal lpszUserName As String, _
    ByVal lpszPassword As String, ByVal dwService As Long, _
    ByVal dwFlags As Long, ByVal dwContext As Long) As Long

Private Declare Function HttpOpenRequestA Lib "wininet.dll" ( _
    ByVal hConnect As Long, ByVal lpszVerb As String, _
    ByVal lpszObjectName As String, ByVal lpszVersion As String, _
    ByVal lpszReferrer As String, ByVal lplpszAcceptTypes As Long, _
    ByVal dwFlags As Long, ByVal dwContext As Long) As Long

Private Declare Function HttpSendRequestA Lib "wininet.dll" ( _
    ByVal hRequest As Long, ByVal lpszHeaders As String, _
    ByVal dwHeadersLength As Long, ByVal lpOptional As String, _
    ByVal dwOptionalLength As Long) As Long

Private Declare Function InternetReadFile Lib "wininet.dll" ( _
    ByVal hFile As Long, ByVal lpBuffer As String, _
    ByVal dwNumberOfBytesToRead As Long, lpdwNumberOfBytesRead As Long) As Long

Private Declare Function InternetCloseHandle Lib "wininet.dll" ( _
    ByVal hInternet As Long) As Long

Private Declare Function InternetSetOptionA Lib "wininet.dll" ( _
    ByVal hInternet As Long, ByVal dwOption As Long, _
    lpBuffer As Any, ByVal dwBufferLength As Long) As Long

Private Const INTERNET_OPTION_RECEIVE_TIMEOUT As Long = 6
Private Const INTERNET_OPTION_CONNECT_TIMEOUT As Long = 2

' ── Core HTTP POST ────────────────────────────────────────────────────────────

Private Function HttpPost(ByVal path As String, ByVal body As String, _
                          ByVal timeout_ms As Long) As String
    InitDefaults
    Dim hInet    As Long
    Dim hConn    As Long
    Dim hReq     As Long
    Dim headers  As String
    Dim buf      As String * 4096
    Dim bytesRead As Long
    Dim response  As String

    hInet = InternetOpenA("Win98Botter/1.0", INTERNET_OPEN_TYPE_PRECONFIG, "", "", 0)
    If hInet = 0 Then HttpPost = "ERROR: InternetOpen failed": Exit Function

    ' Set timeouts
    InternetSetOptionA hInet, INTERNET_OPTION_CONNECT_TIMEOUT, timeout_ms, 4
    InternetSetOptionA hInet, INTERNET_OPTION_RECEIVE_TIMEOUT, timeout_ms, 4

    hConn = InternetConnectA(hInet, RELAY_HOST, RELAY_PORT, "", "", _
                              INTERNET_SERVICE_HTTP, 0, 0)
    If hConn = 0 Then
        InternetCloseHandle hInet
        HttpPost = "ERROR: InternetConnect failed"
        Exit Function
    End If

    hReq = HttpOpenRequestA(hConn, "POST", path, "HTTP/1.1", "", 0, _
                             INTERNET_FLAG_RELOAD Or INTERNET_FLAG_NO_CACHE_WRITE, 0)
    If hReq = 0 Then
        InternetCloseHandle hConn
        InternetCloseHandle hInet
        HttpPost = "ERROR: HttpOpenRequest failed"
        Exit Function
    End If

    headers = "Content-Type: application/json" & vbCrLf
    If HttpSendRequestA(hReq, headers, Len(headers), body, Len(body)) = 0 Then
        InternetCloseHandle hReq
        InternetCloseHandle hConn
        InternetCloseHandle hInet
        HttpPost = "ERROR: HttpSendRequest failed"
        Exit Function
    End If

    response = ""
    Do
        buf       = Space(4096)
        bytesRead = 0
        If InternetReadFile(hReq, buf, 4096, bytesRead) = 0 Then Exit Do
        If bytesRead = 0 Then Exit Do
        response = response & Left(buf, bytesRead)
    Loop

    InternetCloseHandle hReq
    InternetCloseHandle hConn
    InternetCloseHandle hInet

    HttpPost = response
End Function

' ── Core HTTP GET ─────────────────────────────────────────────────────────────

Private Function HttpGet(ByVal path As String) As String
    InitDefaults
    Dim hInet    As Long
    Dim hConn    As Long
    Dim hReq     As Long
    Dim buf      As String * 4096
    Dim bytesRead As Long
    Dim response  As String

    hInet = InternetOpenA("Win98Botter/1.0", INTERNET_OPEN_TYPE_PRECONFIG, "", "", 0)
    If hInet = 0 Then HttpGet = "ERROR: InternetOpen failed": Exit Function

    Dim to_ms As Long: to_ms = 5000
    InternetSetOptionA hInet, INTERNET_OPTION_CONNECT_TIMEOUT, to_ms, 4
    InternetSetOptionA hInet, INTERNET_OPTION_RECEIVE_TIMEOUT, to_ms, 4

    hConn = InternetConnectA(hInet, RELAY_HOST, RELAY_PORT, "", "", _
                              INTERNET_SERVICE_HTTP, 0, 0)
    If hConn = 0 Then
        InternetCloseHandle hInet
        HttpGet = "ERROR: InternetConnect failed"
        Exit Function
    End If

    hReq = HttpOpenRequestA(hConn, "GET", path, "HTTP/1.1", "", 0, _
                             INTERNET_FLAG_RELOAD Or INTERNET_FLAG_NO_CACHE_WRITE, 0)
    If hReq = 0 Then
        InternetCloseHandle hConn
        InternetCloseHandle hInet
        HttpGet = "ERROR: HttpOpenRequest failed"
        Exit Function
    End If

    If HttpSendRequestA(hReq, "", 0, "", 0) = 0 Then
        InternetCloseHandle hReq
        InternetCloseHandle hConn
        InternetCloseHandle hInet
        HttpGet = "ERROR: HttpSendRequest failed"
        Exit Function
    End If

    response = ""
    Do
        buf       = Space(4096)
        bytesRead = 0
        If InternetReadFile(hReq, buf, 4096, bytesRead) = 0 Then Exit Do
        If bytesRead = 0 Then Exit Do
        response = response & Left(buf, bytesRead)
    Loop

    InternetCloseHandle hReq
    InternetCloseHandle hConn
    InternetCloseHandle hInet

    HttpGet = response
End Function

' ── Public API ────────────────────────────────────────────────────────────────

' Send a chat message; returns raw JSON response string
' session_id may be "" for the first message
Public Function PostChat(ByVal msg As String, _
                         ByVal session_id As String, _
                         ByVal agent_id As String, _
                         Optional ByVal source As String = "user") As String
    Dim body As String
    Dim safe_msg As String
    Dim safe_agent_id As String
    Dim safe_session_id As String
    Dim safe_source As String

    safe_msg = EscapeJson(msg)
    safe_agent_id = EscapeJson(agent_id)
    safe_session_id = EscapeJson(session_id)
    safe_source = EscapeJson(source)
    If Len(Trim(safe_source)) = 0 Then safe_source = "user"

    body = "{""message"":""" & safe_msg & """,""source"":""" & safe_source & """"
    If session_id <> "" Then body = body & ",""session_id"":""" & safe_session_id & """"
    If agent_id <> "" Then body = body & ",""agent_id"":""" & safe_agent_id & """"
    body = body & "}"

    PostChat = HttpPost("/chat", body, 120000)
End Function

' Get recent chat history; returns raw JSON
Public Function GetHistory(Optional ByVal agent_id As String = "", _
                           Optional ByVal session_id As String = "", _
                           Optional ByVal source As String = "") As String
    Dim path As String
    path = "/history"

    If agent_id <> "" Or session_id <> "" Or source <> "" Then
        path = path & "?"
        If agent_id <> "" Then path = path & "agent_id=" & EscapeQuery(agent_id)
        If session_id <> "" Then
            If Right$(path, 1) <> "?" Then path = path & "&"
            path = path & "session_id=" & EscapeQuery(session_id)
        End If
        If source <> "" Then
            If Right$(path, 1) <> "?" Then path = path & "&"
            path = path & "source=" & EscapeQuery(source)
        End If
    End If

    GetHistory = HttpGet(path)
End Function

' Send a control command (pause / resume / disconnect)
Public Function PostControl(ByVal cmd As String, Optional ByVal agent_id As String = "") As String
    Dim body As String
    Dim safe_agent_id As String
    safe_agent_id = EscapeJson(agent_id)
    If agent_id <> "" Then
        body = "{""action"":""" & cmd & """,""agent_id"":""" & safe_agent_id & """}"
    Else
        body = "{""action"":""" & cmd & """}"
    End If
    PostControl = HttpPost("/control", body, 5000)
End Function

Public Function PostControlPermissions(ByVal agent_id As String, ByVal permissionsJson As String) As String
    Dim body As String
    Dim safe_agent_id As String
    safe_agent_id = EscapeJson(agent_id)
    If agent_id <> "" Then
        body = "{""action"":""permissions""",""agent_id"":""" & safe_agent_id & """,""permissions"":" & permissionsJson & "}"
    Else
        body = "{""action"":""permissions""",""permissions"":" & permissionsJson & "}"
    End If
    PostControlPermissions = HttpPost("/control", body, 5000)
End Function

' Get relay health; returns raw JSON
Public Function GetHealth() As String
    GetHealth = HttpGet("/health")
End Function

Private Function EscapeJson(ByVal value As String) As String
    Dim safe_value As String
    safe_value = Replace(value, "\", "\\")
    safe_value = Replace(safe_value, Chr$(34), Chr$(92) & Chr$(34))
    safe_value = Replace(safe_value, vbCrLf, "\n")
    safe_value = Replace(safe_value, vbCr, "\n")
    safe_value = Replace(safe_value, vbLf, "\n")
    safe_value = Replace(safe_value, vbTab, "\t")
    EscapeJson = safe_value
End Function

Private Function EscapeQuery(ByVal value As String) As String
    Dim s As String
    s = value
    s = Replace(s, "%", "%25")
    s = Replace(s, " ", "%20")
    s = Replace(s, "\", "%5C")
    s = Replace(s, "/", "%2F")
    s = Replace(s, ":", "%3A")
    s = Replace(s, "?", "%3F")
    s = Replace(s, "&", "%26")
    s = Replace(s, "=", "%3D")
    EscapeQuery = s
End Function
