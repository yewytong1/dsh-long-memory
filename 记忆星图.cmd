@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 双击即可：生成记忆星图 → 用浏览器打开
rem 不依赖 .html 的默认关联（本机那个关联指向 SLBrowserHTML，是坏的）

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 找不到 node。请确认 PATH 里有 node，或在本目录用 pwsh 跑：node scripts\build-panel.mjs
  pause
  exit /b 1
)

echo [1/2] 生成星图...
node scripts\build-panel.mjs
if errorlevel 1 (
  echo.
  echo [x] 生成失败，看上面的报错
  pause
  exit /b 1
)

set "HTML=%~dp0out\panel.html"
if not exist "%HTML%" (
  echo [x] 没找到 %HTML%
  pause
  exit /b 1
)

echo [2/2] 打开 %HTML%
rem 明着找浏览器，不走默认关联
set "BROWSER="
for %%B in (
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) do (
  if not defined BROWSER if exist %%B set "BROWSER=%%~B"
)

if defined BROWSER (
  start "" "%BROWSER%" "%HTML%"
) else (
  echo [!] 没找到 Edge/Chrome，退回系统默认关联
  start "" "%HTML%"
)

rem 成功就静默退出；给 1 秒缓冲，双击时窗口不至于闪得莫名其妙
ping -n 2 127.0.0.1 >nul
exit /b 0
