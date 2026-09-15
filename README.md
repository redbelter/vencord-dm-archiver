# DMArchiver One-Liner Installer (PowerShell)

Run this in PowerShell:

```powershell
irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/ONE-LINER.ps1" -OutFile "$env:TEMP\dmArchiver-install.ps1"; & "$env:TEMP\dmArchiver-install.ps1"
```

This will:
- Check if Vencord is installed
- If not, show instructions to download from vencord.dev/download
- Detect your Discord version
- Create the plugin folder if needed
- Download the plugin files
- Confirm installation with next steps