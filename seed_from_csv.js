// CSKH Time Tracker - Seed from CSV
// Dùng để import danh sách nhân viên từ file CSV vào database SQLite

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
      console.log("   node seed_from_csv.js 'Data CS.csv'");
      process.exit(1);
    }

    if (!fs.existsSync(file)) {
      console.error("Không tìm thấy file:", file);
      process.exit(1);
    }

    console.log("📂 Đang đọc dữ liệu từ:", file);
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

    let added = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const email =
        (r.email || r.gmail || "").trim().toLowerCase();
      if (!email) { skipped++; continue; }

      const display_name =
        r.display_name || r.name || r.fullname || "(Không tên)";
      const role = (r.role || "agent").toLowerCase();
      const salary = parseFloat(
        r.salary_per_hour || r.salary || r.rate || 0
      ) || 0;
      const password = r.password?.trim() || "Default@123";
      const hash = bcrypt.hashSync(password, 10);

      try {
        await db.run(
          "INSERT INTO users(email,password_hash,display_name,role,salary_per_hour) VALUES(?,?,?,?,?)",
          [email, hash, display_name, role, salary]
        );
        added++;
        console.log(`✅ Thêm: ${email} (${role}) - ${salary.toLocaleString("vi-VN")} VND/h`);
      } catch (e) {
        if (String(e).includes("UNIQUE")) {
          await db.run(
            "UPDATE users SET display_name=?, role=?, salary_per_hour=? WHERE email=?",
            [display_name, role, salary, email]
          );
          updated++;
          console.log(`🔁 Cập nhật: ${email}`);
        } else {
          skipped++;
          console.log(`⚠️ Bỏ qua: ${email} - ${String(e).slice(0, 80)}`);
        }
      }
    }

    console.log("🎯 Hoàn tất import:");
    console.log(`   ➕ Thêm mới: ${added}`);
    console.log(`   🔁 Cập nhật: ${updated}`);
    console.log(`   ⚠️ Bỏ qua: ${skipped}`);

    await db.close();
  } catch (err) {
    console.error("❌ Lỗi:", err);
  }
})();
