# DMArchiver One-Liner Installer (PowerShell)

Run this single line in PowerShell:

```powershell
irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/src/plugins/dmArchiver/ONE-LINER.ps1" -OutFile "$env:TEMP\dmArchiver-install.ps1"; & "$env:TEMP\dmArchiver-install.ps1"
```

The actual installer script is at: `src/plugins/dmArchiver/ONE-LINER.ps1`