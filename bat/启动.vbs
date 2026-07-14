Set fso = CreateObject("Scripting.FileSystemObject")
batDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = fso.BuildPath(batDir, "pack-deploy.ps1")

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = batDir
WshShell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1Path & """", 1, True
