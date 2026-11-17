const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const url = require("url");

// =========================================================
// 1. CẤU HÌNH ĐỊNH DANH, IP RIÊNG & VÙNG LƯU TRỮ CÔ LẬP
// =========================================================
const NODE_CONFIG = {
  nodeName: "cappy_micro_node_01",
  virtualIp: "10.88.0.10",        // IP định danh riêng của node
  bindIp: "127.0.0.1",            // IP lắng nghe cục bộ (đổi thành "0.0.0.0" nếu cần mở mạng)
  port: 8090,
  apiPrefix: "/api/v1",
  // Thư mục lưu trữ độc lập hoàn toàn, tách khỏi thư mục gốc của nền tảng
  isolatedRoot: path.resolve(process.cwd(), "micro_vm_storage", "node_01"),
  maxStorageBytes: 50 * 1024 * 1024, // Giới hạn 50MB cho node
  maxVirtualProcs: 16,
};

// =========================================================
// 2. HỆ ĐIỀU HÀNH TỐI GIẢN (MicroOS) TỐI ƯU CHO MÁY CHỦ
// =========================================================
class MicroOS {
  constructor(config) {
    this.config = config;
    this.bootTime = Date.now();
    this.procs = new Map(); // pid -> thông tin tiến trình ảo
    this.nextPid = 100;
    this.dataDir = path.join(config.isolatedRoot, "data");
    this.procLogDir = path.join(config.isolatedRoot, "procs");
    this.initFilesystem();
    this.registerCoreProcs();
  }

  initFilesystem() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.procLogDir, { recursive: true });
  }

  // Khóa chặt đường dẫn: tuyệt đối không cho thoát ra ngoài isolatedRoot
  resolveIsolatedPath(relPath = "") {
    const cleanRel = String(relPath).replace(/^[/\\]+/, "");
    const target = path.resolve(this.dataDir, cleanRel);
    const rootCheck = this.dataDir.endsWith(path.sep)
      ? this.dataDir
      : this.dataDir + path.sep;
    if (target !== this.dataDir && !target.startsWith(rootCheck)) {
      throw new Error("ACCESS_DENIED: Chặn truy cập ngoài thư mục cô lập của node");
    }
    return target;
  }

  getStorageUsageBytes() {
    let total = 0;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      }
    };
    walk(this.config.isolatedRoot);
    return total;
  }

  spawnProc(name, taskFn) {
    if (this.procs.size >= this.config.maxVirtualProcs) {
      throw new Error("PROC_LIMIT: Đạt giới hạn tiến trình của MicroOS");
    }
    const pid = this.nextPid++;
    const record = {
      pid,
      name,
      status: "running",
      startedAt: new Date().toISOString(),
      isolatedDir: this.config.isolatedRoot,
    };
    this.procs.set(pid, record);

    // Chạy tác vụ trong try/catch cô lập, không làm sập nền tảng
    Promise.resolve()
      .then(taskFn)
      .then(() => {
        record.status = "idle";
        record.lastRunAt = new Date().toISOString();
      })
      .catch((err) => {
        record.status = "degraded";
        record.lastError = err.message;
        this.writeIsolatedFile(`proc_${pid}.err`, `${new Date().toISOString()} ${err.stack || err}\n`, true);
      });

    return record;
  }

  registerCoreProcs() {
    this.spawnProc("micro_init", async () => {
      this.writeIsolatedFile("node_manifest.json", JSON.stringify({
        nodeName: this.config.nodeName,
        virtualIp: this.config.virtualIp,
        isolatedRoot: this.config.isolatedRoot,
        createdAt: new Date().toISOString(),
      }, null, 2));
    });

    this.spawnProc("storage_guard", async () => {
      const used = this.getStorageUsageBytes();
      if (used > this.config.maxStorageBytes) {
        throw new Error(`QUOTA_EXCEEDED: ${used} > ${this.config.maxStorageBytes}`);
      }
    });
  }

  writeIsolatedFile(relName, content, append = false) {
    const fullPath = this.resolveIsolatedPath(relName);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (append) fs.appendFileSync(fullPath, content, "utf8");
    else fs.writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  readIsolatedFile(relName) {
    const fullPath = this.resolveIsolatedPath(relName);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, "utf8");
  }

  getSysInfo() {
    return {
      osName: "MicroOS-Node-Lite",
      nodeName: this.config.nodeName,
      virtualIp: this.config.virtualIp,
      bindIp: this.config.bindIp,
      port: this.config.port,
      isolatedRoot: this.config.isolatedRoot,
      storageUsedBytes: this.getStorageUsageBytes(),
      storageMaxBytes: this.config.maxStorageBytes,
      uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
      hostMemFreeMb: Math.floor(os.freemem() / (1024 * 1024)),
      activeProcs: Array.from(this.procs.values()),
    };
  }
}

// =========================================================
// 3. KHỞI TẠO NODE & API ĐIỀU KHIỂN ĐỘC LẬP
// =========================================================
const microOS = new MicroOS(NODE_CONFIG);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "X-Node-Name": NODE_CONFIG.nodeName,
    "X-Node-Virtual-IP": NODE_CONFIG.virtualIp,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const prefix = NODE_CONFIG.apiPrefix;

  try {
    if (req.method === "GET" && p === `${prefix}/info`) {
      return sendJson(res, 200, { ok: true, sys: microOS.getSysInfo() });
    }

    if (req.method === "GET" && p === `${prefix}/fs/read`) {
      const file = parsed.query.file || "node_manifest.json";
      const content = microOS.readIsolatedFile(file);
      if (content === null) return sendJson(res, 404, { ok: false, error: "File không tồn tại trong kho cô lập" });
      return sendJson(res, 200, { ok: true, file, content });
    }

    if (req.method === "POST" && p === `${prefix}/fs/write`) {
      let raw = "";
      req.on("data", (c) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const savedPath = microOS.writeIsolatedFile(body.file || "store.json", body.content || "");
        return sendJson(res, 200, { ok: true, savedPath });
      });
      return;
    }

    if (req.method === "POST" && p === `${prefix}/proc/spawn`) {
      let raw = "";
      req.on("data", (c) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const proc = microOS.spawnProc(body.name || "worker_task", async () => {
          microOS.writeIsolatedFile("worker_heartbeat.log", `${new Date().toISOString()} tick\n`, true);
        });
        return sendJson(res, 200, { ok: true, proc });
      });
      return;
    }

    return sendJson(res, 404, {
      ok: false,
      endpoints: [
        `GET ${prefix}/info`,
        `GET ${prefix}/fs/read?file=node_manifest.json`,
        `POST ${prefix}/fs/write`,
        `POST ${prefix}/proc/spawn`,
      ],
    });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
});

// Cô lập lỗi tiến trình để không đụng chạm thư mục/tiến trình gốc
process.on("uncaughtException", (err) => {
  try {
    microOS.writeIsolatedFile("os_panic.log", `${new Date().toISOString()} ${err.stack || err}\n`, true);
  } catch (_) {}
});

server.listen(NODE_CONFIG.port, NODE_CONFIG.bindIp, () => {
  console.log(`[${NODE_CONFIG.nodeName}] VirtualIP=${NODE_CONFIG.virtualIp} | Root=${NODE_CONFIG.isolatedRoot}`);
  console.log(`API: http://${NODE_CONFIG.bindIp}:${NODE_CONFIG.port}${NODE_CONFIG.apiPrefix}/info`);
});
