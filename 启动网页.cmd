@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] 未检测到 Node.js，请先安装 Node.js 后再运行本项目。
  pause
  exit /b 1
)

echo 正在启动小说生成工作台...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$wd = '%~dp0';" ^
  "$proc = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $wd -PassThru;" ^
  "$ready = $false;" ^
  "for($i=0; $i -lt 24; $i++){" ^
  "  try { Invoke-WebRequest 'http://127.0.0.1:3210/api/health' -UseBasicParsing -TimeoutSec 1 | Out-Null; $ready = $true; break }" ^
  "  catch { Start-Sleep -Milliseconds 500 }" ^
  "}" ^
  "Start-Process 'http://127.0.0.1:3210';" ^
  "if($ready){ Write-Host '电脑端已打开：http://127.0.0.1:3210' } else { Write-Host '服务启动较慢，浏览器已尝试打开。' }"

echo.
echo 手机专用入口：
echo http://你的局域网IP:3210/mobile.html
echo.
echo 如需关闭服务，请在任务管理器中结束 node.exe。
pause
