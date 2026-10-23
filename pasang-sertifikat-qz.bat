@echo off
setlocal
title Pasang sertifikat QZ Tray - SIAP Tabang
rem Jalankan SEKALI di setiap komputer yang mencetak lewat QZ Tray.
rem Setelah ini QZ Tray tidak lagi meminta "Allow" setiap kali mencetak.
rem Alamat server bisa diganti: pasang-sertifikat-qz.bat https://alamat-server-anda
set "SERVER=%~1"
if "%SERVER%"=="" set "SERVER=https://pelayanan-tabang.akkreatif.com"
set "QZDIR=%ProgramFiles%\QZ Tray"

rem Minta hak Administrator (folder Program Files)
net session >nul 2>&1 || (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%SERVER%' -Verb RunAs"
  exit /b
)

if not exist "%QZDIR%\qz-tray.exe" (
  echo QZ Tray belum terpasang. Unduh dan pasang dari https://qz.io/download lalu jalankan file ini lagi.
  pause & exit /b 1
)

if exist "%~dp0qz-cert\digital-certificate.txt" (
  echo Memakai sertifikat dari folder proyek...
  copy /y "%~dp0qz-cert\digital-certificate.txt" "%QZDIR%\override.crt" >nul
) else (
  echo Mengunduh sertifikat dari %SERVER% ...
  curl -fsSL "%SERVER%/api/qz/cert" -o "%QZDIR%\override.crt"
)
if errorlevel 1 (
  echo Gagal memasang sertifikat. Periksa koneksi internet / alamat server.
  pause & exit /b 1
)
findstr /c:"BEGIN CERTIFICATE" "%QZDIR%\override.crt" >nul || (
  echo File sertifikat tidak valid. Periksa alamat server.
  del "%QZDIR%\override.crt" >nul 2>&1
  pause & exit /b 1
)

echo Memulai ulang QZ Tray...
powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*\QZ Tray\*' } | Stop-Process -Force"
timeout /t 3 /nobreak >nul
start "" "%QZDIR%\qz-tray.exe"

echo.
echo Selesai. Sertifikat terpasang di "%QZDIR%\override.crt".
echo Buka halaman antrian, menu Printer, lalu klik "Cek koneksi printer".
pause
