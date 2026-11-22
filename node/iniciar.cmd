@echo off
rem Inicia o servidor do Stream Deck (Node/TypeScript) e abre a pagina de configuracao (Windows).
cd /d "%~dp0"
if not exist node_modules call npm install --no-audit --no-fund
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8765"
node src/main.ts
