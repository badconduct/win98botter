VERSION 5.00
Begin VB.Form frmAbout
   BorderStyle     =   3  'Fixed Dialog
   Caption         =   "About Win98Botter"
   ClientHeight    =   2520
   ClientLeft      =   60
   ClientTop       =   360
   ClientWidth     =   4080
   StartUpPosition =   2  'CenterScreen

   Begin VB.Label lblTitle
      Alignment   =   2  'Center
      Caption     =   "Win98Botter"
      FontBold    =   -1 'True
      FontSize    =   14
      Height      =   375
      Left        =   120
      Top         =   240
      Width       =   3840
   End
   Begin VB.Label lblVersion
      Alignment   =   2  'Center
      Caption     =   "v1.0   —   Windows 98SE AI Agent"
      Height      =   255
      Left        =   120
      Top         =   720
      Width       =   3840
   End
   Begin VB.Label lblDescription
      Alignment   =   2  'Center
      Caption     =   "GUI frontend for the Win98 MCP relay agent." & vbCrLf & _
                       "Connects to LLM relay over localhost HTTP."
      Height      =   615
      Left        =   120
      Top         =   1080
      Width       =   3840
      WordWrap    =   -1 'True
   End
   Begin VB.CommandButton btnClose
      Cancel   =   -1  'True
      Caption  =   "Close"
      Default  =   -1  'True
      Height   =   375
      Left     =   1560
      TabIndex =   0
      Top      =   1920
      Width    =   975
   End
End
Attribute VB_Name = "frmAbout"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Option Explicit

Private Sub btnClose_Click()
    Unload Me
End Sub
