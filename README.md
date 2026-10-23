# siap-tabang

Sistem antrian pelayanan Kecamatan Tabang (Node.js 22.13+, database SQLite bawaan).

Jalankan: `node server.js` (atau `jalankan.bat`), lalu buka http://localhost:3000.

## Printer kabel di Windows (QZ Tray)

Setiap komputer yang mencetak struk:

1. Pasang printer thermal sampai muncul di *Settings → Printers*.
2. Pasang dan jalankan [QZ Tray](https://qz.io/download).
3. Jalankan **`pasang-sertifikat-qz.bat`** sekali saja (minta izin Administrator). Dengan file ini, QZ Tray tidak meminta "Allow" setiap mencetak.
   File ini juga bisa diunduh dari server: `https://<domain>/pasang-sertifikat-qz.bat`.
4. Buka halaman antrian, menu **🖨 Printer**, klik **Printer kabel di Windows (QZ Tray)**, lalu klik **✔ Cek koneksi printer**. Semua langkah harus ✅ dan struk tes harus keluar.

Sertifikat ada di folder `qz-cert/`:
- `digital-certificate.txt`: sertifikat publik. Disalin ke QZ Tray sebagai `override.crt`.
- `private-key.pem`: **kunci rahasia**. Upload ke server bersama `server.js`, tapi jangan dibagikan atau di-commit.

Jika sertifikat dibuat ulang, jalankan lagi `pasang-sertifikat-qz.bat` di semua komputer.
