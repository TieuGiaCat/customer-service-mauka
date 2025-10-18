import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ORIGIN = process.env.CORS_ORIGIN || '*';
const DB_FILE = process.env.DATABASE_FILE || './data.sqlite';

const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const app = express();
app.use(cors({ origin: ORIGIN }));
app.options('*', cors({ origin: ORIGIN }));
app.use(express.json());
app.use('/static', express.static(path.join(process.cwd(), 'public')));

let db;
(async () => {
  db = await open({ filename: DB_FILE, driver: sqlite3.Database });
  await db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT
    );
    CREATE TABLE IF NOT EXISTS attendance(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      work_ms INTEGER DEFAULT 0,
      break_ms INTEGER DEFAULT 0,
      date_start INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS presence(
      user_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,                -- 'offline' | 'working' | 'break'
      started_at INTEGER,                  -- copy from attendance.started_at if any
      last_seen INTEGER NOT NULL,          -- updated by heartbeat
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_open ON attendance(user_id, ended_at);
  `);
})();

function signToken(u){ return jwt.sign({ uid: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req,res,next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).send('No token');
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e){ return res.status(401).send('Invalid token'); }
}

app.get('/', (req,res) => res.json({ ok:true, name:'CSKH Time API', db: DB_FILE }));

app.post('/auth/signup', async (req,res) => {
  try {
    const { email, password, display_name } = req.body || {};
    if (!email || !password) return res.status(400).send('Missing email/password');
    if (String(password).length < 6) return res.status(400).send('Password must be >= 6 chars');
    const hash = bcrypt.hashSync(password, 10);
    const r = await db.run('INSERT INTO users(email,password_hash,display_name) VALUES(?,?,?)', [String(email).toLowerCase(), hash, display_name || null]);
    return res.json({ ok:true, user_id: r.lastID });
  } catch(e){
    if (String(e).includes('UNIQUE')) return res.status(409).send('Email exists');
    return res.status(500).send('Signup failed');
  }
});

app.post('/auth/login', async (req,res) => {
  const { email, password } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE email=?', [String(email||'').toLowerCase()]);
  if (!u) return res.status(401).send('Invalid credentials');
  const ok = bcrypt.compareSync(password, u.password_hash);
  if (!ok) return res.status(401).send('Invalid credentials');
  const token = signToken(u);
  res.json({ token, profile: { id: u.id, email: u.email, display_name: u.display_name || u.email.split('@')[0] } });
});

app.get('/me', auth, async (req,res) => {
  const u = await db.get('SELECT id,email,display_name FROM users WHERE id=?', [req.user.uid]);
  res.json({ profile: u });
});

async function getOpenSession(user_id){
  return await db.get('SELECT * FROM attendance WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [user_id]);
}

app.post('/attendance/check-in', auth, async (req,res) => {
  const startedAt = Number(req.body?.startedAt || Date.now());
  const dateStart = new Date(startedAt); dateStart.setHours(0,0,0,0);
  const open = await getOpenSession(req.user.uid);
  if (open) await db.run('UPDATE attendance SET ended_at=?, work_ms=?, break_ms=? WHERE id=?', [startedAt, 0, 0, open.id]);
  const r = await db.run('INSERT INTO attendance(user_id,started_at,date_start) VALUES(?,?,?)', [req.user.uid, startedAt, dateStart.getTime()]);
  // mark presence 'working'
  await db.run('INSERT INTO presence(user_id,status,started_at,last_seen) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, started_at=excluded.started_at, last_seen=excluded.last_seen',
    [req.user.uid, 'working', startedAt, Date.now()]);
  res.json({ ok:true, attendance_id: r.lastID });
});

app.post('/attendance/break/start', auth, async (req,res) => {
  await db.run('INSERT INTO presence(user_id,status,last_seen) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, last_seen=excluded.last_seen',
    [req.user.uid, 'break', Date.now()]);
  res.json({ ok:true });
});
app.post('/attendance/break/end', auth, async (req,res) => {
  await db.run('INSERT INTO presence(user_id,status,last_seen) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, last_seen=excluded.last_seen',
    [req.user.uid, 'working', Date.now()]);
  res.json({ ok:true });
});

app.post('/attendance/check-out', auth, async (req,res) => {
  const end = Number(req.body?.endedAt || Date.now());
  const open = await getOpenSession(req.user.uid);
  if (open) await db.run('UPDATE attendance SET ended_at=? WHERE id=?', [end, open.id]);
  // mark presence 'offline'
  await db.run('INSERT INTO presence(user_id,status,last_seen,started_at) VALUES(?,?,?,NULL) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, last_seen=excluded.last_seen, started_at=NULL',
    [req.user.uid, 'offline', Date.now()]);
  res.json({ ok:true });
});

app.post('/attendance/log', auth, async (req,res) => {
  const { dateStart, startedAt, endedAt, workMs, breakMs } = req.body || {};
  if (!startedAt || !endedAt) return res.status(400).send('Missing timestamps');
  const r = await db.run('INSERT INTO attendance(user_id,started_at,ended_at,work_ms,break_ms,date_start) VALUES(?,?,?,?,?,?)',
    [req.user.uid, startedAt, endedAt, Math.max(0,Number(workMs)||0), Math.max(0,Number(breakMs)||0), Number(dateStart)||0]);
  res.json({ ok:true, id: r.lastID });
});

app.get('/attendance/today', auth, async (req,res) => {
  const sod = new Date(); sod.setHours(0,0,0,0); const start = sod.getTime();
  const rows = await db.all('SELECT work_ms, break_ms FROM attendance WHERE user_id=? AND date_start>=?', [req.user.uid, start]);
  let work=0, br=0; for (const e of rows) { work += e.work_ms||0; br += e.break_ms||0; }
  res.json({ workMs: work, breakMs: br });
});

app.get('/attendance/export', auth, async (req,res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days)||30));
  const fromTs = Date.now() - days*86400000;
  const rows = await db.all('SELECT * FROM attendance WHERE user_id=? AND started_at>=? ORDER BY started_at DESC', [req.user.uid, fromTs]);
  const header = ['Date','Start','End','Work (h)','Break (h)'];
  const lines = [header.join(',')];
  const pad = (n) => String(n).padStart(2,'0');
  for (const e of rows) {
    const sd = new Date(e.started_at); const ed = e.ended_at ? new Date(e.ended_at) : null;
    const date = `${sd.getFullYear()}-${pad(sd.getMonth()+1)}-${pad(sd.getDate())}`;
    const st = `${pad(sd.getHours())}:${pad(sd.getMinutes())}:${pad(sd.getSeconds())}`;
    const et = ed ? `${pad(ed.getHours())}:${pad(ed.getMinutes())}:${pad(ed.getSeconds())}` : '';
    const wh = (Number(e.work_ms||0)/3600000).toFixed(2);
    const bh = (Number(e.break_ms||0)/3600000).toFixed(2);
    lines.push([date, st, et, wh, bh].join(','));
  }
  const csv = lines.join('\n');
  res.json({ filename: `cskh-timesheet-${new Date().toISOString().slice(0,10)}.csv`, csv });
});

// ----- Heartbeat presence -----
app.post('/presence/beat', auth, async (req,res) => {
  const { status, startedAt } = req.body || {};
  const st = ['offline','working','break'].includes(status) ? status : 'offline';
  const started = Number(startedAt) || null;
  await db.run('INSERT INTO presence(user_id,status,started_at,last_seen) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, started_at=excluded.started_at, last_seen=excluded.last_seen',
    [req.user.uid, st, started, Date.now()]);
  res.json({ ok:true });
});

// ---- Admin web & API ----
app.get('/admin/online', auth, async (req,res) => {
  // online if last_seen within last 90s and status != 'offline'
  const cutoff = Date.now() - 90000;
  const rows = await db.all(`
    SELECT u.id AS user_id, u.email, u.display_name, p.status, p.started_at, p.last_seen
    FROM presence p
    JOIN users u ON u.id = p.user_id
    WHERE p.last_seen >= ? AND p.status != 'offline'
    ORDER BY p.last_seen DESC
  `, [cutoff]);
  res.json({ online: rows });
});

app.get('/admin', (req,res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

const adminHtml = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>CSKH Admin - Presence</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:20px}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #e5e7eb;padding:8px;text-align:left}
    th{background:#f9fafb} input,button{padding:8px;border:1px solid #e5e7eb;border-radius:8px}
    .row{display:flex;gap:8px;margin:8px 0;align-items:center}
    .muted{color:#6b7280}
  </style>
</head>
<body>
  <h1>Đang trong giờ làm (Heartbeat)</h1>
  <div class="row">
    <input id="baseUrl" placeholder="https://customer-service-mauka.onrender.com" style="flex:1"/>
    <input id="token" placeholder="Bearer token (JWT)" style="flex:2"/>
    <button id="loadBtn">Tải</button>
  </div>
  <table>
    <thead><tr><th>Tên</th><th>Email</th><th>Trạng thái</th><th>Start</th><th>Last seen</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <p class="muted">Online = last_seen ≤ 90s + status != offline</p>
<script>
  const $ = (id) => document.getElementById(id);
  $('baseUrl').value = window.location.origin;
  $('loadBtn').addEventListener('click', async () => {
    const url = $('baseUrl').value.trim().replace(/\/$/, '');
    const token = $('token').value.trim();
    const r = await fetch(url + '/admin/online', { headers: { Authorization: 'Bearer ' + token } });
    const data = await r.json();
    const tb = $('tbody'); tb.innerHTML = '';
    (data.online||[]).forEach(u => {
      const tr = document.createElement('tr');
      const sd = u.started_at ? new Date(u.started_at).toLocaleString() : '';
      const ls = u.last_seen ? new Date(u.last_seen).toLocaleString() : '';
      tr.innerHTML = `<td>${u.display_name||''}</td><td>${u.email}</td><td>${u.status}</td><td>${sd}</td><td>${ls}</td>`;
      tb.appendChild(tr);
    });
  });
</script>
</body></html>`;

const pub = path.join(process.cwd(), 'public');
if (!fs.existsSync(pub)) fs.mkdirSync(pub, { recursive: true });
fs.writeFileSync(path.join(pub, 'admin.html'), adminHtml);

app.listen(PORT, () => console.log('CSKH Time API listening on ' + PORT + ' (DB: ' + DB_FILE + ')'));
