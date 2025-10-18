
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

let db;
(async () => {
  db = await open({ filename: './data.sqlite', driver: sqlite3.Database });
  await db.exec(`
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

app.get('/', (req,res) => res.json({ ok:true, name:'CSKH Time API' }));

app.post('/auth/signup', async (req,res) => {
  const { email, password, display_name } = req.body || {};
  if (!email || !password) return res.status(400).send('Missing email/password');
  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = await db.run('INSERT INTO users(email,password_hash,display_name) VALUES(?,?,?)', [email, hash, display_name || null]);
    return res.json({ ok:true, user_id: r.lastID });
  } catch(e){
    if (String(e).includes('UNIQUE')) return res.status(409).send('Email exists');
    return res.status(500).send('Signup failed');
  }
});

app.post('/auth/login', async (req,res) => {
  const { email, password } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE email=?', [email]);
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

// Helper: get open session for user
async function getOpenSession(user_id){
  return await db.get('SELECT * FROM attendance WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [user_id]);
}

app.post('/attendance/check-in', auth, async (req,res) => {
  const startedAt = Number(req.body?.startedAt || Date.now());
  const dateStart = new Date(startedAt); dateStart.setHours(0,0,0,0);
  // Close any dangling session (safety)
  const open = await getOpenSession(req.user.uid);
  if (open) {
    await db.run('UPDATE attendance SET ended_at=?, work_ms=?, break_ms=? WHERE id=?', [startedAt, 0, 0, open.id]);
  }
  const r = await db.run('INSERT INTO attendance(user_id,started_at,date_start) VALUES(?,?,?)', [req.user.uid, startedAt, dateStart.getTime()]);
  res.json({ ok:true, attendance_id: r.lastID });
});

app.post('/attendance/break/start', auth, async (req,res) => {
  res.json({ ok:true });
});
app.post('/attendance/break/end', auth, async (req,res) => {
  res.json({ ok:true });
});

app.post('/attendance/check-out', auth, async (req,res) => {
  const end = Number(req.body?.endedAt || Date.now());
  const open = await getOpenSession(req.user.uid);
  if (!open) return res.json({ ok:true, note:'no open session' });
  await db.run('UPDATE attendance SET ended_at=? WHERE id=?', [end, open.id]);
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
  let work=0, br=0; for (const r of rows) { work += r.work_ms||0; br += r.break_ms||0; }
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

app.listen(PORT, () => console.log('CSKH Time API listening on ' + PORT));
