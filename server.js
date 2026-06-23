const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const PUBLIC_DIR = path.join(__dirname, "public");

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
    day: new Date().toISOString().slice(0, 10),
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : 0
  };
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/health") {
    sendJson(res, 200, { ok: true });
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

      writeQueue = writeQueue.then(() => {
        const records = readRecords();
        records.push(record);
        saveRecords(records);
      });
      await writeQueue;
      sendJson(res, 200, { ok: true, record });
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
    const records = readRecords().sort((a, b) => new Date(b.time) - new Date(a.time));
    sendJson(res, 200, { ok: true, records });
    return;
  }

  if (req.method === "GET" && req.url === "/api/records.csv") {
    if (!isAdmin(req)) {
      sendText(res, 401, "管理员密码不正确");
      return;
    }
    const header = ["类型", "姓名", "学院", "学号/工号", "时间", "纬度", "经度", "精度(米)", "IP"];
    const rows = readRecords().map(record => [
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

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Attendance app running on port ${PORT}`);
});
