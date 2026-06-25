const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const PUBLIC_DIR = path.join(__dirname, "public");
let pool = null;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

let writeQueue = Promise.resolve();
let databaseReady = false;

function requireDatabase() {
  if (!pool) {
    throw new Error("数据库未配置，已拒绝保存。请先在 Render 设置 DATABASE_URL。");
  }
}

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      college TEXT NOT NULL,
      person_id TEXT NOT NULL,
      time TIMESTAMPTZ NOT NULL,
      day TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      accuracy INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    )
  `);
  databaseReady = true;
}

async function getDatabaseStatus() {
  if (!pool) {
    return {
      ok: false,
      databaseConfigured: false,
      databaseReady: false,
      message: "数据库未配置，系统已禁止签到，避免记录丢失。"
    };
  }

  try {
    await initDatabase();
    await pool.query("SELECT 1");
    databaseReady = true;
    return {
      ok: true,
      databaseConfigured: true,
      databaseReady: true,
      message: "数据库已连接，签到记录会长期保存。"
    };
  } catch (error) {
    databaseReady = false;
    return {
      ok: false,
      databaseConfigured: true,
      databaseReady: false,
      message: error.message || "数据库连接失败。"
    };
  }
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RECORDS_FILE)) {
    fs.writeFileSync(RECORDS_FILE, "[]\n");
  }
}

function readRecords() {
  ensureStore();
  try {
    const text = fs.readFileSync(RECORDS_FILE, "utf8");
    const records = JSON.parse(text);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function saveRecords(records) {
  ensureStore();
  fs.writeFileSync(RECORDS_FILE, `${JSON.stringify(records, null, 2)}\n`);
}

async function listRecords() {
  requireDatabase();

  await initDatabase();
  const result = await pool.query(`
    SELECT
      id,
      type,
      name,
      college,
      person_id AS "personId",
      time,
      day,
      latitude,
      longitude,
      accuracy,
      ip,
      user_agent AS "userAgent"
    FROM attendance_records
    ORDER BY time DESC
  `);
  return result.rows.map(record => ({
    ...record,
    time: new Date(record.time).toISOString()
  }));
}

function getShanghaiDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function addRecord(record) {
  requireDatabase();

  await initDatabase();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
      [`${record.day}:${record.personId}:${record.type}`]
    );

    const existing = await client.query(
      `SELECT
        id,
        type,
        name,
        college,
        person_id AS "personId",
        time,
        day,
        latitude,
        longitude,
        accuracy,
        ip,
        user_agent AS "userAgent"
      FROM attendance_records
      WHERE day = $1 AND person_id = $2 AND type = $3
      ORDER BY time ASC
      LIMIT 1`,
      [record.day, record.personId, record.type]
    );

    if (existing.rows.length) {
      await client.query("COMMIT");
      const existingRecord = existing.rows[0];
      return {
        duplicate: true,
        record: {
          ...existingRecord,
          time: new Date(existingRecord.time).toISOString()
        }
      };
    }

    await client.query(
      `INSERT INTO attendance_records (
        id, type, name, college, person_id, time, day,
        latitude, longitude, accuracy, ip, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id,
        record.type,
        record.name,
        record.college,
        record.personId,
        record.time,
        record.day,
        record.latitude,
        record.longitude,
        record.accuracy,
        record.ip,
        record.userAgent
      ]
    );
    await client.query("COMMIT");
    return { duplicate: false, record };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function isAdmin(req) {
  return req.headers["x-admin-password"] === ADMIN_PASSWORD;
}

function validatePunch(payload) {
  const name = String(payload.name || "").trim();
  const college = String(payload.college || "").trim();
  const personId = String(payload.personId || "").trim();
  const type = String(payload.type || "").trim();
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const accuracy = Number(payload.accuracy || 0);

  if (!name || name.length > 40) return "请输入有效姓名";
  if (!college || college.length > 60) return "请输入有效学院";
  if (!personId || personId.length > 40) return "请输入有效学号/工号";
  if (!["签到", "签退"].includes(type)) return "签到类型不正确";
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return "定位纬度不正确";
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return "定位经度不正确";

  return {
    id: crypto.randomUUID(),
    type,
    name,
    college,
    personId,
    time: new Date().toISOString(),
    day: getShanghaiDay(),
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : 0
  };
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/health") {
    const storage = await getDatabaseStatus();
    sendJson(res, 200, {
      ok: true,
      databaseConfigured: storage.databaseConfigured,
      databaseReady: storage.databaseReady
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/storage-status") {
    const storage = await getDatabaseStatus();
    sendJson(res, storage.ok ? 200 : 503, storage);
    return;
  }

  if (req.method === "POST" && req.url === "/api/punch") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const recordOrError = validatePunch(payload);
      if (typeof recordOrError === "string") {
        sendJson(res, 400, { ok: false, error: recordOrError });
        return;
      }

      const record = {
        ...recordOrError,
        ip: getClientIp(req),
        userAgent: req.headers["user-agent"] || ""
      };

      const result = await addRecord(record);
      sendJson(res, 200, {
        ok: true,
        duplicate: result.duplicate,
        message: result.duplicate ? `您已${record.type}` : `${record.type}成功`,
        record: result.record
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || "保存失败" });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/records") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { ok: false, error: "管理员密码不正确" });
      return;
    }
    try {
      const records = await listRecords();
      sendJson(res, 200, { ok: true, records });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error.message || "数据库读取失败" });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/records.csv") {
    if (!isAdmin(req)) {
      sendText(res, 401, "管理员密码不正确");
      return;
    }
    let rows;
    try {
      rows = (await listRecords()).map(record => [
        record.type,
        record.name,
        record.college,
        record.personId,
        record.time,
        record.latitude,
        record.longitude,
        record.accuracy,
        record.ip
      ]);
    } catch (error) {
      sendText(res, 503, error.message || "数据库读取失败");
      return;
    }
    const header = ["类型", "姓名", "学院", "学号/工号", "时间", "纬度", "经度", "精度(米)", "IP"];
    const csv = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\n");
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=attendance-records.csv",
      "cache-control": "no-store"
    });
    res.end(`\ufeff${csv}`);
    return;
  }

  sendJson(res, 404, { ok: false, error: "接口不存在" });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
}

ensureStore();
initDatabase().catch(error => {
  console.error("Database initialization failed:", error);
});

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Attendance app running on port ${PORT}`);
});
