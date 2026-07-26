# DMArchiver One-Liner Installer (PowerShell)

Run this command in PowerShell:

```powershell
 $username=$env:USERNAME;$appSettings="C:\Users\$username\AppData\Roaming\Discord\app-settings.json";$dcVer="0.0.XXX";if(Test-Path $appSettings){try{$dcVer=(gc $appSettings -Raw|ConvertFrom-Json).version}catch{}};$pluginDir="C:\Users\$username\AppData\Roaming\Discord\$dcVer\modules\vencord\plugins\dmArchiver";if(-not(Test-Path $pluginDir)){ni -ItemType Directory -Path $pluginDir -Force|Out-Null};irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/src/plugins/dmArchiver/index.ts" -OutFile (Join-Path $pluginDir "index.ts");irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/src/plugins/dmArchiver/README.md" -OutFile (Join-Path $pluginDir "README.md");Write-Host "Plugin installed! Reload Discord or Vencord plugins." -ForegroundColor Green
```

This will:
- Detect your Discord version
- Create the plugin folder if needed
- Download the plugin files
- Confirm installation