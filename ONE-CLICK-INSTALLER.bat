@echo off
echo ========================================
echo   DMArchiver - ONE CLICK INSTALLER
echo ========================================
echo.

cd /d %APPDATA%\Discord

for /f "delims=" %%a in ('dir /b /ad *.*.* ^| sort -r ^| head -1') do set "latestVer=%%a"
echo [1/3] Detected Discord version: %latestVer%

set "vencordPath=%APPDATA%\Discord\%latestVer%\modules\vencord"
if not exist "%vencordPath%" (
    echo [ERROR] Vencord not found!
    echo Please install Vencord from: https://vencord.dev/download/
    pause
    exit /b 1
)
echo [1/3] Vencord found: %vencordPath%

echo [2/3] Creating plugin folder...
if not exist "%vencordPath%\plugins\dmArchiver" (
    mkdir "%vencordPath%\plugins\dmArchiver" 2>nul
)
echo [2/3] Plugin folder ready

echo [3/3] Downloading plugin files...
powershell -Command ^
    "$baseUrl='https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master'; ^
    irm \"$baseUrl/index.ts\" -OutFile '%vencordPath%\plugins\dmArchiver\index.ts'; ^
    irm \"$baseUrl/README.md\" -OutFile '%vencordPath%\plugins\dmArchiver\README.md'"

echo.
echo ========================================
echo   DONE! Plugin downloaded successfully
echo ========================================
echo.
echo Next steps:
echo 1. Clone Vencord: git clone https://github.com/Vendicated/Vencord.git
echo 2. Copy dmArchiver folder to Vencord\src\plugins\
echo 3. Run: cd Vencord && pnpm build
echo.
echo Or use the one-click batch file for full automation:
echo   https://github.com/redbelter/vencord-dm-archiver/raw/master/AUTO-BUILD.bat
echo.
pause