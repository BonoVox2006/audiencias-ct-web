@echo off
cd /d "%~dp0"
echo Atualizando lista de comissoes (pode levar alguns segundos)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-orgaos-cache.ps1"
if errorlevel 1 (
  echo Falha ao gerar cache. Verifique sua conexao.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
pause
