' DevSpec devspec:// protocol handler entry point (Windows).
'
' Real bug found live-testing: the registry command previously invoked
' devspec-handler.cmd directly. A .cmd/.bat file always needs a console host
' to run — Windows Shell briefly flashes a visible cmd window for it even
' though the batch file itself finishes almost instantly. Every other window
' in this whole chain (the opencode serve process, the connect client call)
' was fixed to run invisibly, but this outermost hop — the very first
' process Windows launches for the URL, before any of our own spawn code
' even runs — was never addressed, since we don't control the flags Windows
' Shell uses to invoke a registered protocol handler.
'
' Fix: register THIS .vbs as the handler instead, invoked via
' `wscript.exe //B`. wscript.exe has no console of its own, and
' WshShell.Run's third argument (0 = hidden window style) launches
' devspec-handler.cmd with no visible window at all — the standard,
' well-established Windows trick for "run this without ever flashing a
' console," used because Windows Shell gives us no spawn-flag control over
' the registered command itself.
Dim shell, fso, scriptDir, targetCmd, url

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
targetCmd = scriptDir & "\devspec-handler.cmd"

url = ""
If WScript.Arguments.Count > 0 Then
  url = WScript.Arguments(0)
End If

shell.Run """" & targetCmd & """ """ & url & """", 0, False
