// CSKH Time Tracker Backend v1.3.1 – VND Edition
// Author: Mauka Team

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname cho ES Modules (KHAI BÁO MỘT LẦN)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const ORIGIN = process.env.CORS_ORIGIN || "*";
const DB_FILE = process.env.DATABASE_FILE || "./data.sqlite";


// __dirname cho ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đảm bảo thư mục DB tồn tại
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

// ---------- Database ----------
let db;
(async () => {
  db = await open({ filename: DB_FILE, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'agent',
      salary_per_hour REAL DEFAULT 0
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
      status TEXT,
      started_at INTEGER,
      last_seen INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
  console.log("✅ Database ready:", DB_FILE);
})();

// ---------- Helpers ----------
function signToken(u) {
  return jwt.sign(
    { uid: u.id, email: u.email, role: u.role },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).send("Missing token");
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).send("Forbidden");
    next();
  };
}

// ---------- Auth ----------
app.post("/auth/signup", async (req, res) => {
  const { email, password, display_name } = req.body || {};
  if (!email || !password)
    return res.status(400).send("Email và mật khẩu là bắt buộc");
  if (password.length < 6)
    return res.status(400).send("Mật khẩu tối thiểu 6 ký tự");

  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = await db.run(
      "INSERT INTO users(email,password_hash,display_name) VALUES(?,?,?)",
      [String(email).toLowerCase(), hash, display_name || null]
    );
    res.json({ ok: true, user_id: r.lastID });
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      return res.status(409).send("Email đã tồn tại");
    res.status(500).send("Lỗi server");
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.get("SELECT * FROM users WHERE email=?", [String(email).toLowerCase()]);
  if (!u) return res.status(401).send("Sai tài khoản hoặc mật khẩu");
  if (!bcrypt.compareSync(password, u.password_hash))
    return res.status(401).send("Sai tài khoản hoặc mật khẩu");
  const token = signToken(u);
  res.json({
    token,
    profile: {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      salary_per_hour: u.salary_per_hour,
    },
  });
});

// ---------- Attendance ----------
app.post("/attendance/check-in", auth, async (req, res) => {
  const startedAt = Date.now();
  const sod = new Date(startedAt); sod.setHours(0, 0, 0, 0);
  await db.run(
    "INSERT INTO attendance(user_id,started_at,date_start) VALUES(?,?,?)",
    [req.user.uid, startedAt, sod.getTime()]
  );
  res.json({ ok: true });
});

// break start/end (extension gọi; không cần ghi DB)
app.post("/attendance/break/start", auth, async (_req, res) => res.json({ ok: true }));
app.post("/attendance/break/end",   auth, async (_req, res) => res.json({ ok: true }));

app.post("/attendance/check-out", auth, async (req, res) => {
  const end = Date.now();
  await db.run(
    "UPDATE attendance SET ended_at=? WHERE user_id=? AND ended_at IS NULL",
    [end, req.user.uid]
  );
  res.json({ ok: true });
});

app.post("/attendance/log", auth, async (req, res) => {
  const { dateStart, startedAt, endedAt, workMs, breakMs } = req.body || {};
  if (!startedAt || !endedAt) return res.status(400).send("Thiếu timestamp");
  await db.run(
    "INSERT INTO attendance(user_id,started_at,ended_at,work_ms,break_ms,date_start) VALUES(?,?,?,?,?,?)",
    [req.user.uid, startedAt, endedAt, workMs || 0, breakMs || 0, dateStart || 0]
  );
  res.json({ ok: true });
});

app.get("/attendance/today", auth, async (req, res) => {
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const rows = await db.all(
    "SELECT work_ms FROM attendance WHERE user_id=? AND date_start>=?",
    [req.user.uid, sod.getTime()]
  );
  const workMs = rows.reduce((s, r) => s + (r.work_ms || 0), 0);
  res.json({ workMs, total_hours: Math.floor(workMs / 3_600_000) });
});

// ---------- Presence ----------
app.post("/presence/beat", auth, async (req, res) => {
  const { status, startedAt } = req.body || {};
  const now = Date.now();
  await db.run(
    "INSERT INTO presence(user_id,status,started_at,last_seen) VALUES(?,?,?,?) " +
    "ON CONFLICT(user_id) DO UPDATE SET status=?, started_at=?, last_seen=?",
    [req.user.uid, status, startedAt, now, status, startedAt, now]
  );
  res.json({ ok: true });
});

// ---------- Public / Leader / Admin ----------
app.get("/public/online", async (_req, res) => {
  const cutoff = Date.now() - 90_000;
  const rows = await db.all(
    `SELECT u.display_name, p.status, p.started_at, p.last_seen
     FROM presence p JOIN users u ON u.id=p.user_id
     WHERE p.last_seen>? AND p.status!='offline'
     ORDER BY p.last_seen DESC`,
    [cutoff]
  );
  res.json({ online: rows });
});

// Leader summary
app.get("/leader/summary", auth, requireRole(["leader", "admin"]), async (req, res) => {
  const from = Number(req.query.from) || Date.now() - 86_400_000;
  const to = Number(req.query.to) || Date.now();
  const rows = await db.all(
    "SELECT user_id, work_ms FROM attendance WHERE started_at BETWEEN ? AND ?",
    [from, to]
  );
  const perUser = new Map();
  for (const r of rows) perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + (r.work_ms || 0));
  let total_hours = 0;
  for (const v of perUser.values()) total_hours += Math.floor(v / 3_600_000);
  res.json({ total_hours, users_count: perUser.size, from, to });
});

// Admin: employees list
app.get("/admin/employees", auth, requireRole(["admin"]), async (_req, res) => {
  const rows = await db.all(
    "SELECT id,email,display_name,role,salary_per_hour FROM users ORDER BY id ASC"
  );
  res.json({ employees: rows });
});

// ---- API payroll (yêu cầu token) ----
app.get("/api/admin/payroll", auth, requireRole(["admin"]), async (req, res) => {
  const from = Number(req.query.from) || Date.now() - 30 * 86_400_000;
  const to = Number(req.query.to) || Date.now();

  const att = await db.all(
    "SELECT user_id, work_ms FROM attendance WHERE started_at BETWEEN ? AND ?",
    [from, to]
  );
  const users = await db.all(
    "SELECT id,email,display_name,salary_per_hour FROM users"
  );

  const msMap = new Map();
  for (const a of att) msMap.set(a.user_id, (msMap.get(a.user_id) || 0) + (a.work_ms || 0));

  const payroll = users.map(u => {
    const ms = msMap.get(u.id) || 0;
    const hours = Math.floor(ms / 3_600_000);     // làm tròn xuống
    const pay = hours * (u.salary_per_hour || 0); // VND
    return {
      email: u.email,
      display_name: u.display_name,
      hours,
      salary_per_hour: u.salary_per_hour,
      pay,
      currency: "VND",
    };
  });

  res.json({ from, to, payroll });
});

// ---------- Static HTML (KHÔNG yêu cầu token) ----------
app.use("/public", express.static(path.join(__dirname, "public")));

// Map /app -> public/app.html (và cho phép load các asset trong /public)
app.use("/app", express.static(path.join(__dirname, "public"), { index: "app.html" }));


app.get("/admin/online", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "online.html"))
);

app.get("/admin/payroll", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "payroll.html"))
);


// ✅ NEW: route gốc (root) để khi mở domain chính không báo lỗi
app.get("/", (_req, res) => {
  // Cách 1: Redirect gọn gàng về /app
  res.redirect("/app");

  // Nếu muốn hiển thị trực tiếp thì dùng dòng dưới thay cho redirect:
  // res.sendFile(path.join(__dirname, "public", "app.html"));
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`✅ CSKH Time API running on :${PORT}`));

