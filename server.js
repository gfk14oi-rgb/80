const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Thư mục lưu trữ nằm ngay bên trong thư mục của chính máy chủ đang chạy
const SERVER_ROOT = path.join(__dirname, "server_store");
fs.mkdirSync(SERVER_ROOT, { recursive: true });

const INSTANCE_ID = "srv_" + crypto.randomBytes(4).toString("hex");
const INSTANCE_DIR = path.join(SERVER_ROOT, INSTANCE_ID);
fs.mkdirSync(INSTANCE_DIR, { recursive: true });

function safeTarget(fileName = "state.json") {
  const cleanName = path.basename(String(fileName));
  return path.join(INSTANCE_DIR, cleanName);
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://localhost");

  if (req.method === "GET" && (parsed.pathname === "/" || parsed.pathname === "/status")) {
    return sendJson(res, 200, {
      ok: true,
      instanceId: INSTANCE_ID,
      storageDir: INSTANCE_DIR,
      files: fs.readdirSync(INSTANCE_DIR),
    });
  }

  if (req.method === "GET" && parsed.pathname === "/read") {
    const file = parsed.searchParams.get("file") || "state.json";
    const target = safeTarget(file);
    if (!fs.existsSync(target)) {
      return sendJson(res, 404, { ok: false, error: "File not found" });
    }
    return sendJson(res, 200, {
      ok: true,
      file: path.basename(target),
      content: fs.readFileSync(target, "utf8"),
    });
  }

  if (req.method === "POST" && parsed.pathname === "/write") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const target = safeTarget(body.file || "state.json");
        const content =
          typeof body.content === "string"
            ? body.content
            : JSON.stringify(body.content ?? {}, null, 2);
        fs.writeFileSync(target, content, "utf8");
        return sendJson(res, 200, { ok: true, file: path.basename(target) });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  return sendJson(res, 404, {
    ok: false,
    endpoints: ["GET /status", "GET /read?file=state.json", "POST /write"],
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("STARTED:", INSTANCE_ID, "DIR:", INSTANCE_DIR);
});
