@echo off
title Sistem Antrian Kecamatan Tabang
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js belum terpasang. Unduh di https://nodejs.org lalu jalankan lagi file ini. & pause & exit /b 1)
echo Menjalankan server antrian... JANGAN tutup jendela ini selama pelayanan berlangsung.
echo.
start "" http://localhost:3000
node server.js
echo.
echo Server berhenti.
pause
