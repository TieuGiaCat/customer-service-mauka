// CSKH Time Tracker - Seed from CSV
import fs from "fs";
import { parse } from "csv-parse/sync";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcryptjs";

const DB_FILE = process.env.DATABASE_FILE || "./data.sqlite";

(async () => {
  try {
    const file = process.argv[2];
    if (!file) {
      console.log("❗️Cách dùng:");
      console.log("   node seed_from_csv.js 'Data CS (chuẩn hoá).csv'");
      process.exit(1);
    }

    const raw = fs.readFileSync(file);
    const rows = parse(raw, { columns: true, skip_empty_lines: true });
    const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'agent',
        salary_per_hour REAL DEFAULT 0
      );
    `);

    let added = 0, updated = 0;
    for (const r of rows) {
      const email = (r.email || "").trim().toLowerCase();
      if (!email) continue;
      const display_name = r.display_name || r.name || "(Không tên)";
      const role = (r.role || "agent").toLowerCase();
      const salary = parseFloat(r.salary_per_hour || 0);
      const password = r.password || "Default@123";
      const hash = bcrypt.hashSync(password, 10);

      try {
        await db.run(
          "INSERT INTO users(email,password_hash,display_name,role,salary_per_hour) VALUES(?,?,?,?,?)",
          [email, hash, display_name, role, salary]
        );
        added++;
      } catch (e) {
        if (String(e).includes("UNIQUE")) {
          await db.run(
            "UPDATE users SET display_name=?, role=?, salary_per_hour=? WHERE email=?",
            [display_name, role, salary, email]
          );
          updated++;
        }
      }
    }

    console.log(`🎯 Hoàn tất import → Thêm mới: ${added}, Cập nhật: ${updated}`);
    await db.close();
  } catch (err) {
    console.error("❌ Lỗi:", err);
  }
})();
