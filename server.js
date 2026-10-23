/* Server Sistem Antrian Kecamatan Tabang
   - Database SQLite (file antrian.db) memakai modul bawaan Node.js (node:sqlite), tanpa instal paket.
   - Menyajikan halaman sistem-antrian.html, rekap.html dan API JSON.
   - Jalankan: node server.js  → buka http://localhost:3000 (atau IP komputer ini dari perangkat lain). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DIR = __dirname;
const DB_FILE = process.env.DB_FILE || path.join(DIR, 'antrian.db');
const DEFAULT_USER = process.env.ADMIN_USER || 'admin';      // akun awal, dibuat sekali saat database masih kosong
const DEFAULT_PASS = process.env.ADMIN_PASS || 'tabang2026';
const SESSION_MS = 12 * 3600e3;                                // login berlaku 12 jam

/* Sertifikat QZ Tray: perintah cetak ditandatangani server agar QZ Tray tidak meminta "Allow" setiap kali.
   digital-certificate.txt juga disalin ke folder QZ Tray sebagai override.crt (lihat README). */
const QZ_DIR = path.join(DIR, 'qz-cert');
const readOpt = f => { try { return fs.readFileSync(path.join(QZ_DIR, f), 'utf8'); } catch { return null; } };
const QZ_CERT = readOpt('digital-certificate.txt');
const QZ_KEY = readOpt('private-key.pem');

/* ===== DATABASE ===== */
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tickets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    day        TEXT    NOT NULL,             -- tanggal lokal YYYY-MM-DD
    num        INTEGER NOT NULL,             -- nomor urut harian
    code       TEXT    NOT NULL,             -- kode Kasi (P, K, U, T)
    svc        TEXT    NOT NULL,             -- nama layanan
    status     TEXT    NOT NULL DEFAULT 'waiting',  -- waiting | called | pending | done | cancelled
    loket      INTEGER,
    created_at INTEGER NOT NULL,             -- epoch ms
    called_at  INTEGER,
    done_at    INTEGER,
    UNIQUE(day, num)
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_day_status ON tickets(day, status);
  CREATE TABLE IF NOT EXISTS days (
    day        TEXT PRIMARY KEY,
    current_id INTEGER,                      -- tiket yang sedang dipanggil di admin
    last_id    INTEGER                       -- tiket terakhir dipanggil (tampil di layar pengunjung)
  );
  CREATE TABLE IF NOT EXISTS users (
    username   TEXT PRIMARY KEY,
    pass_hash  TEXT    NOT NULL,             -- salt:scrypt-hash
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS status_log (   -- jejak perubahan status manual oleh admin
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL,
    from_status TEXT   NOT NULL,
    to_status  TEXT    NOT NULL,
    username   TEXT    NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const pad = n => String(n).padStart(3, '0');
const toClient = r => ({
  id: r.id, day: r.day, code: r.code, svc: r.svc, num: r.num, no: pad(r.num), status: r.status,
  loket: r.loket, at: r.created_at, calledAt: r.called_at, doneAt: r.done_at,
});

const q = {
  ensureDay: db.prepare('INSERT OR IGNORE INTO days(day) VALUES (?)'),
  getDay:    db.prepare('SELECT current_id, last_id FROM days WHERE day = ?'),
  setDay:    db.prepare('UPDATE days SET current_id = ?, last_id = ? WHERE day = ?'),
  ticketsOf: db.prepare('SELECT * FROM tickets WHERE day = ? ORDER BY id'),
  ticket:    db.prepare('SELECT * FROM tickets WHERE id = ?'),
  nextNum:   db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM tickets WHERE day = ?'),
  insert:    db.prepare('INSERT INTO tickets(day, num, code, svc, created_at) VALUES (?, ?, ?, ?, ?)'),
  sameSvc:   db.prepare('SELECT svc FROM tickets WHERE code = ? AND svc = ? COLLATE NOCASE ORDER BY id LIMIT 1'),
  call:      db.prepare("UPDATE tickets SET status = 'called', loket = ?, called_at = ? WHERE id = ?"),
  finish:    db.prepare('UPDATE tickets SET status = ?, done_at = ? WHERE id = ?'),
  logStatus: db.prepare('INSERT INTO status_log(ticket_id, from_status, to_status, username, at) VALUES (?, ?, ?, ?, ?)'),
  range:     db.prepare('SELECT * FROM tickets WHERE day BETWEEN ? AND ? ORDER BY day, num'),
  firstDay:  db.prepare('SELECT MIN(day) AS d FROM tickets'),
  popular:   db.prepare('SELECT code, svc, COUNT(*) AS n FROM tickets GROUP BY code, svc'),
  user:      db.prepare('SELECT * FROM users WHERE username = ?'),
  anyUser:   db.prepare('SELECT 1 FROM users LIMIT 1'),
  addUser:   db.prepare('INSERT INTO users(username, pass_hash, created_at) VALUES (?, ?, ?)'),
  setPass:   db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?'),
  addSess:   db.prepare('INSERT INTO sessions(token, username, expires_at) VALUES (?, ?, ?)'),
  getSess:   db.prepare('SELECT username FROM sessions WHERE token = ? AND expires_at > ?'),
  delSess:   db.prepare('DELETE FROM sessions WHERE token = ?'),
  delOthers: db.prepare('DELETE FROM sessions WHERE username = ? AND token <> ?'),
  purgeSess: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ===== ANTRIAN ===== */
function getState() {
  const day = today();
  q.ensureDay.run(day);
  const d = q.getDay.get(day);
  return { day, tickets: q.ticketsOf.all(day).map(toClient), current: d.current_id, last: d.last_id };
}

function takeTicket({ code, svc }) {
  if (typeof code !== 'string' || !code || code.length > 8) throw httpErr(400, 'Kode Kasi tidak valid');
  if (typeof svc === 'string') svc = svc.replace(/\s+/g, ' ').trim();
  if (typeof svc !== 'string' || !svc || svc.length > 300) throw httpErr(400, 'Nama layanan tidak valid');
  return tx(() => {
    // layanan ketik manual: samakan dengan penulisan yang sudah ada (beda huruf besar/kecil) agar jadi 1 rekapan
    const same = q.sameSvc.get(code, svc);
    if (same) svc = same.svc;
    const day = today();
    const num = q.nextNum.get(day).n;
    const { lastInsertRowid } = q.insert.run(day, num, code, svc, Date.now());
    return toClient(q.ticket.get(lastInsertRowid));
  });
}

function callTicket({ id, loket }) {
  return tx(() => {
    const day = today();
    q.ensureDay.run(day);
    const d = q.getDay.get(day);
    const cur = d.current_id && q.ticket.get(d.current_id);
    if (cur && cur.status === 'called') return { error: 'busy' };
    const t = q.ticket.get(+id);
    if (!t || t.day !== day || (t.status !== 'waiting' && t.status !== 'pending')) return { error: 'invalid' };
    q.call.run(+loket || null, Date.now(), t.id);
    q.setDay.run(t.id, t.id, day);
    return { ticket: toClient(q.ticket.get(t.id)) };
  });
}

function resolveTicket({ status }) {
  if (!['done', 'pending', 'cancelled'].includes(status)) throw httpErr(400, 'Status tidak valid');
  return tx(() => {
    const day = today();
    q.ensureDay.run(day);
    const d = q.getDay.get(day);
    const cur = d.current_id && q.ticket.get(d.current_id);
    if (!cur || cur.status !== 'called') return { error: 'none' };
    q.finish.run(status, Date.now(), cur.id);
    q.setDay.run(null, d.last_id, day);
    return { ticket: toClient(q.ticket.get(cur.id)) };
  });
}

/* Ubah status tiket yang sudah selesai/dibatalkan (mis. salah klik Batal).
   'waiting' = kembali ke antrian di posisi semula (urut nomor). */
function editStatus(user, { id, status }) {
  if (!['waiting', 'pending', 'done', 'cancelled'].includes(status)) throw httpErr(400, 'Status tidak valid');
  return tx(() => {
    const t = q.ticket.get(+id);
    if (!t || t.day !== today()) throw httpErr(400, 'Hanya antrian hari ini yang bisa diubah');
    if (t.status === 'called') throw httpErr(400, 'Antrian sedang dipanggil, selesaikan dulu (Lanjut / Pending / Batal)');
    if (t.status === status) return { ticket: toClient(t) };
    q.finish.run(status, status === 'done' || status === 'cancelled' ? Date.now() : null, t.id);
    q.logStatus.run(t.id, t.status, status, user, Date.now());
    return { ticket: toClient(q.ticket.get(t.id)) };
  });
}

/* ===== LOGIN ADMIN ===== */
function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pass, salt, 64).toString('hex');
}
function checkPass(pass, stored) {
  const [salt, hash] = String(stored).split(':');
  const a = Buffer.from(hash || '', 'hex'), b = crypto.scryptSync(String(pass), salt || '', 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (!q.anyUser.get()) {
  q.addUser.run(DEFAULT_USER, hashPass(DEFAULT_PASS), Date.now());
  console.log(`Akun admin dibuat → username: ${DEFAULT_USER}  password: ${DEFAULT_PASS}  (segera ganti di halaman Rekap)`);
}

const fails = new Map();   // ip → {n, until}: kunci 5 menit setelah 5x salah password
function login(req, res, { username, password }) {
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw httpErr(429, `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((f.until - Date.now()) / 60000)} menit.`);
  // halaman Admin hanya meminta password → tanpa username dianggap akun admin bawaan
  const u = q.user.get((typeof username === 'string' && username.trim()) || DEFAULT_USER);
  if (!u || !checkPass(password, u.pass_hash)) {
    f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 5 * 60e3; }
    fails.set(ip, f);
    throw httpErr(401, 'Username atau password salah');
  }
  fails.delete(ip);
  q.purgeSess.run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  q.addSess.run(token, u.username, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  return { user: u.username };
}
function sessionToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && m[1];
}
function requireUser(req) {
  const t = sessionToken(req);
  const s = t && q.getSess.get(t, Date.now());
  if (!s) throw httpErr(401, 'Silakan login');
  return s.username;
}
function changePassword(req, { old, pass }) {
  const user = requireUser(req);
  if (typeof pass !== 'string' || pass.length < 6) throw httpErr(400, 'Password baru minimal 6 karakter');
  if (!checkPass(old, q.user.get(user).pass_hash)) throw httpErr(400, 'Password lama salah');
  q.setPass.run(hashPass(pass), user);
  q.delOthers.run(user, sessionToken(req));   // keluarkan sesi lain yang memakai password lama
  return { ok: true };
}

/* ===== REKAP & LAPORAN ===== */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function range(params) {
  let from = params.get('from'), to = params.get('to');
  if (from === 'all') from = q.firstDay.get().d || today();
  if (!DAY_RE.test(from)) from = today();
  if (!DAY_RE.test(to)) to = today();
  if (from > to) [from, to] = [to, from];
  return [from, to];
}
function rekap(from, to) {
  const rows = q.range.all(from, to);
  const status = { waiting: 0, called: 0, pending: 0, done: 0, cancelled: 0 };
  const kasi = {}, svc = {}, days = {}, hours = Array(24).fill(0);
  let waitSum = 0, waitN = 0, serveSum = 0, serveN = 0;
  for (const r of rows) {
    status[r.status] = (status[r.status] || 0) + 1;
    const k = kasi[r.code] ||= { code: r.code, total: 0, done: 0, pending: 0, cancelled: 0 };
    k.total++; if (k[r.status] !== undefined) k[r.status]++;
    const s = svc[r.code + '|' + r.svc] ||= { code: r.code, svc: r.svc, total: 0 };
    s.total++;
    const d = days[r.day] ||= { day: r.day, total: 0, done: 0, pending: 0, cancelled: 0 };
    d.total++; if (d[r.status] !== undefined) d[r.status]++;
    hours[new Date(r.created_at).getHours()]++;
    if (r.called_at) { waitSum += r.called_at - r.created_at; waitN++; }
    if (r.called_at && r.done_at && r.status === 'done') { serveSum += r.done_at - r.called_at; serveN++; }
  }
  return {
    from, to, total: rows.length, status,
    avgWaitMs: waitN ? Math.round(waitSum / waitN) : null,
    avgServeMs: serveN ? Math.round(serveSum / serveN) : null,
    byKasi: Object.values(kasi).sort((a, b) => b.total - a.total),
    byService: Object.values(svc).sort((a, b) => b.total - a.total),
    byDay: Object.values(days).sort((a, b) => b.day.localeCompare(a.day)),
    byHour: hours,
    tickets: rows.map(toClient).reverse(),
  };
}
const STATUS_ID = { waiting: 'Menunggu', called: 'Dipanggil', pending: 'Pending', done: 'Lanjut', cancelled: 'Batal' };
function exportCsv(from, to) {
  const cell = v => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const time = ms => ms ? new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
  const rows = [['Tanggal', 'Nomor', 'Kode Kasi', 'Layanan', 'Status', 'Loket', 'Ambil', 'Dipanggil', 'Selesai']];
  for (const r of q.range.all(from, to)) {
    rows.push([r.day, pad(r.num), r.code, r.svc, STATUS_ID[r.status] || r.status, r.loket, time(r.created_at), time(r.called_at), time(r.done_at)]);
  }
  return { name: `antrian_${from}${to !== from ? '_sd_' + to : ''}.csv`, body: '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n') };
}

/* ===== PEMBARUAN LANGSUNG (Server-Sent Events) ===== */
const clients = new Set();
function broadcast() { for (const res of clients) res.write('data: u\n\n'); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

/* ===== HTTP ===== */
function httpErr(code, msg) { const e = new Error(msg); e.status = code; return e; }
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e5) { reject(httpErr(413, 'Data terlalu besar')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpErr(400, 'JSON tidak valid')); } });
    req.on('error', reject);
  });
}
const STATIC = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const PUBLIC_JS = new Set(['config.js', 'qz-tray.js']);   // hanya file JS ini yang boleh diunduh (server.js tidak)
const PAGES = { '/': 'sistem-antrian.html', '/rekap': 'rekap.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (req.method === 'GET') {
      if (p === '/api/state') return send(res, 200, getState());
      if (p === '/api/popular') return send(res, 200, q.popular.all());   // jumlah tiket per layanan (sepanjang waktu)
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/pasang-sertifikat-qz.bat') {   // pemasang sertifikat QZ untuk komputer lain
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="pasang-sertifikat-qz.bat"', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(DIR, 'pasang-sertifikat-qz.bat')));
      }
      if (p === '/api/qz/cert') return QZ_CERT ? send(res, 200, QZ_CERT, 'text/plain; charset=utf-8') : send(res, 404, { error: 'Sertifikat QZ belum dibuat' });
      if (p === '/api/me') return send(res, 200, { user: requireUser(req) });
      if (p === '/api/rekap') { requireUser(req); return send(res, 200, rekap(...range(url.searchParams))); }
      if (p === '/api/export.csv') {
        requireUser(req);
        const { name, body } = exportCsv(...range(url.searchParams));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
    }
    if (req.method === 'POST') {
      if (['/api/tickets', '/api/call', '/api/resolve', '/api/status'].includes(p)) {
        const user = p !== '/api/tickets' && requireUser(req);   // memanggil & mengubah antrian hanya untuk admin yang login
        const body = await readJson(req);
        const result = p === '/api/tickets' ? { ticket: takeTicket(body) }
                     : p === '/api/call'    ? callTicket(body)
                     : p === '/api/status'  ? editStatus(user, body)
                     :                        resolveTicket(body);
        if (!result.error) broadcast();
        return send(res, 200, { ...result, state: getState() });
      }
      if (p === '/api/login') return send(res, 200, login(req, res, await readJson(req)));
      if (p === '/api/logout') {
        const t = sessionToken(req); if (t) q.delSess.run(t);
        res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(res, 200, { ok: true });
      }
      if (p === '/api/password') return send(res, 200, changePassword(req, await readJson(req)));
      if (p === '/api/qz/sign') {
        // hanya untuk halaman dari server ini sendiri, bukan situs lain yang dibuka di browser yang sama
        let sameOrigin = false;
        try {
          const o = new URL(req.headers.origin).host;   // di VPS, Nginx bisa meneruskan Host asli lewat X-Forwarded-Host
          sameOrigin = o === req.headers.host || o === String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        } catch {}
        if (!sameOrigin) throw httpErr(403, 'Asal permintaan tidak diizinkan');
        if (!QZ_KEY) throw httpErr(404, 'Kunci QZ belum dibuat');
        const { data } = await readJson(req);
        if (typeof data !== 'string' || !data) throw httpErr(400, 'Data kosong');
        return send(res, 200, crypto.sign('sha512', Buffer.from(data), QZ_KEY).toString('base64'), 'text/plain; charset=utf-8');
      }
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const file = PAGES[p] || decodeURIComponent(p.slice(1));
      const full = path.resolve(DIR, file);
      const ext = path.extname(full).toLowerCase();
      const type = ext === '.js' ? (PUBLIC_JS.has(path.relative(DIR, full)) &&'text/javascript; charset=utf-8') : STATIC[ext];
      if (type && full.startsWith(DIR + path.sep) && fs.existsSync(full)) return send(res, 200, fs.readFileSync(full), type);
    }
    send(res, 404, { error: 'Tidak ditemukan' });
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Kesalahan server' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sistem Antrian berjalan. Database: ${DB_FILE}`);
  console.log(`  Komputer ini : http://localhost:${PORT}        (rekap: http://localhost:${PORT}/rekap)`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`  Jaringan     : http://${n.address}:${PORT}`);
  }
});
