import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data.json");
const PORT = Number(process.env.PORT) || 3000;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  return null;
}

function defaultData() {
  const spaceId = randomUUID();
  return {
    users: {},
    sessions: {},
    spaces: [{
      id: spaceId, name: "Hearth", icon: "🔥",
      invite: Math.random().toString(36).slice(2, 8).toUpperCase(),
      ownerId: "system", createdAt: Date.now(),
    }],
    memberships: [],
    channels: [
      { id: randomUUID(), spaceId, name: "general", topic: "Talk about anything", category: "Text Channels" },
      { id: randomUUID(), spaceId, name: "introductions", topic: "Say hi", category: "Text Channels" },
      { id: randomUUID(), spaceId, name: "memes", topic: "", category: "Text Channels" },
    ],
    messages: [],
    dms: [],
    dmMessages: [],
  };
}

let db = load() || defaultData();
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
save();

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString("hex");
}
function makeSalt() {
  return randomBytes(16).toString("hex");
}
function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function publicUser(u) {
  return { id: u.id, email: u.email, displayName: u.displayName, status: u.status || "Online" };
}

const sseClients = [];
const onlineUsers = new Set();

function broadcast(payload, filterFn) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const c = sseClients[i];
    if (filterFn && !filterFn(c.userId)) continue;
    try { c.res.write(data); } catch {
      sseClients.splice(i, 1);
      onlineUsers.delete(c.userId);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function getToken(req) {
  const h = req.headers.authorization || "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

function requireUser(req, res) {
  const token = getToken(req);
  const session = db.sessions[token];
  if (!session) { sendJson(res, 401, { error: "Not signed in" }); return null; }
  const user = Object.values(db.users).find((u) => u.id === session.userId);
  if (!user) { sendJson(res, 401, { error: "User missing" }); return null; }
  return { user, token };
}

function isMember(spaceId, userId) {
  return db.memberships.some((m) => m.spaceId === spaceId && m.userId === userId);
}

function mime(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": mime(filePath) });
  res.end(data);
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (pathname === "/api/events" && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    const token = u.searchParams.get("token") || getToken(req);
    const session = db.sessions[token];
    if (!session) { res.writeHead(401); return res.end(); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    const client = { res, userId: session.userId };
    sseClients.push(client);
    onlineUsers.add(session.userId);
    broadcast({ type: "presence", userId: session.userId, online: true });
    req.on("close", () => {
      const i = sseClients.indexOf(client);
      if (i >= 0) sseClients.splice(i, 1);
      if (!sseClients.some((c) => c.userId === session.userId)) {
        onlineUsers.delete(session.userId);
        broadcast({ type: "presence", userId: session.userId, online: false });
      }
    });
    return;
  }

  try {
    if (pathname === "/api/register" && req.method === "POST") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const displayName = String(body.displayName || "").trim().slice(0, 32);
      if (!email.includes("@")) return sendJson(res, 400, { error: "Enter a valid email" });
      if (password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters" });
      if (!displayName) return sendJson(res, 400, { error: "Display name is required" });
      if (db.users[email]) return sendJson(res, 400, { error: "Email already registered" });
      const id = randomUUID();
      const salt = makeSalt();
      db.users[email] = { id, email, displayName, salt, hash: hashPassword(password, salt), status: "Online" };
      const first = db.spaces[0];
      if (first && !isMember(first.id, id)) {
        db.memberships.push({
          spaceId: first.id, userId: id, displayName,
          role: db.memberships.length === 0 ? "owner" : "member", joinedAt: Date.now(),
        });
      }
      const token = randomUUID();
      db.sessions[token] = { userId: id, createdAt: Date.now() };
      save();
      return sendJson(res, 200, { token, user: publicUser(db.users[email]) });
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = db.users[email];
      if (!user || !verifyPassword(password, user.salt, user.hash)) {
        return sendJson(res, 400, { error: user ? "Wrong password" : "No account with that email" });
      }
      const token = randomUUID();
      db.sessions[token] = { userId: user.id, createdAt: Date.now() };
      save();
      return sendJson(res, 200, { token, user: publicUser(user) });
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      delete db.sessions[ctx.token]; save();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      return sendJson(res, 200, { user: publicUser(ctx.user) });
    }

    if (pathname === "/api/spaces" && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      return sendJson(res, 200, { spaces: db.spaces.filter((s) => isMember(s.id, ctx.user.id)) });
    }

    if (pathname === "/api/spaces" && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 32);
      if (!name) return sendJson(res, 400, { error: "Name required" });
      const id = randomUUID();
      const chId = randomUUID();
      const space = {
        id, name, icon: name.charAt(0).toUpperCase(),
        invite: Math.random().toString(36).slice(2, 8).toUpperCase(),
        ownerId: ctx.user.id, createdAt: Date.now(),
      };
      db.spaces.push(space);
      db.memberships.push({
        spaceId: id, userId: ctx.user.id, displayName: ctx.user.displayName,
        role: "owner", joinedAt: Date.now(),
      });
      db.channels.push({ id: chId, spaceId: id, name: "general", topic: "Welcome!", category: "Text Channels" });
      save();
      broadcast({ type: "spaces" });
      return sendJson(res, 200, { space, channelId: chId });
    }

    if (pathname === "/api/spaces/join" && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const code = String(body.invite || "").trim().toUpperCase();
      const space = db.spaces.find((s) => s.invite === code);
      if (!space) return sendJson(res, 400, { error: "Invalid invite code" });
      if (!isMember(space.id, ctx.user.id)) {
        db.memberships.push({
          spaceId: space.id, userId: ctx.user.id, displayName: ctx.user.displayName,
          role: "member", joinedAt: Date.now(),
        });
        save();
        broadcast({ type: "members", spaceId: space.id });
      }
      const ch = db.channels.find((c) => c.spaceId === space.id);
      return sendJson(res, 200, { space, channelId: ch?.id || null });
    }

    let m;
    m = pathname.match(/^\/api\/spaces\/([^/]+)\/channels$/);
    if (m && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      if (!isMember(m[1], ctx.user.id)) return sendJson(res, 403, { error: "Not a member" });
      return sendJson(res, 200, { channels: db.channels.filter((c) => c.spaceId === m[1]) });
    }

    m = pathname.match(/^\/api\/spaces\/([^/]+)\/members$/);
    if (m && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      if (!isMember(m[1], ctx.user.id)) return sendJson(res, 403, { error: "Not a member" });
      const members = db.memberships.filter((x) => x.spaceId === m[1]).map((x) => ({
        userId: x.userId, displayName: x.displayName, role: x.role, online: onlineUsers.has(x.userId),
      }));
      return sendJson(res, 200, { members });
    }

    if (pathname === "/api/channels" && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      if (!isMember(body.spaceId, ctx.user.id)) return sendJson(res, 403, { error: "Not a member" });
      let name = String(body.name || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 24);
      if (!name) return sendJson(res, 400, { error: "Name required" });
      const ch = { id: randomUUID(), spaceId: body.spaceId, name, topic: String(body.topic || "").trim().slice(0, 120), category: "Text Channels" };
      db.channels.push(ch); save();
      broadcast({ type: "channels", spaceId: body.spaceId });
      return sendJson(res, 200, { channel: ch });
    }

    m = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
    if (m && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const ch = db.channels.find((c) => c.id === m[1]);
      if (!ch) return sendJson(res, 404, { error: "Channel not found" });
      if (!isMember(ch.spaceId, ctx.user.id)) return sendJson(res, 403, { error: "Not a member" });
      const messages = db.messages.filter((x) => x.channelId === ch.id && !x.deleted).sort((a, b) => a.ts - b.ts).slice(-200);
      return sendJson(res, 200, { messages });
    }

    if (m && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const ch = db.channels.find((c) => c.id === m[1]);
      if (!ch) return sendJson(res, 404, { error: "Channel not found" });
      if (!isMember(ch.spaceId, ctx.user.id)) return sendJson(res, 403, { error: "Not a member" });
      const body = await readBody(req);
      const text = String(body.body || "").trim().slice(0, 2000);
      if (!text) return sendJson(res, 400, { error: "Empty message" });
      const msg = {
        id: randomUUID(), channelId: ch.id, userId: ctx.user.id, authorName: ctx.user.displayName,
        body: text, ts: Date.now(), reactions: {}, replyTo: body.replyTo || null,
      };
      db.messages.push(msg);
      if (db.messages.length > 5000) db.messages = db.messages.slice(-4000);
      save();
      broadcast({ type: "message", channelId: ch.id, message: msg });
      return sendJson(res, 200, { message: msg });
    }

    m = pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (m && req.method === "PATCH") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const msg = db.messages.find((x) => x.id === m[1]);
      if (!msg || msg.userId !== ctx.user.id) return sendJson(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      if (body.body != null) { msg.body = String(body.body).trim().slice(0, 2000); msg.edited = true; }
      if (body.deleted) msg.deleted = true;
      save();
      broadcast({ type: "message", channelId: msg.channelId, message: msg });
      return sendJson(res, 200, { message: msg });
    }

    m = pathname.match(/^\/api\/messages\/([^/]+)\/react$/);
    if (m && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const msg = db.messages.find((x) => x.id === m[1]);
      if (!msg) return sendJson(res, 404, { error: "Not found" });
      const body = await readBody(req);
      const emoji = String(body.emoji || "").slice(0, 8);
      if (!emoji) return sendJson(res, 400, { error: "No emoji" });
      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      const i = msg.reactions[emoji].indexOf(ctx.user.id);
      if (i >= 0) msg.reactions[emoji].splice(i, 1);
      else msg.reactions[emoji].push(ctx.user.id);
      if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
      save();
      broadcast({ type: "message", channelId: msg.channelId, message: msg });
      return sendJson(res, 200, { message: msg });
    }

    if (pathname === "/api/dms" && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const list = db.dms.filter((d) => d.userIds.includes(ctx.user.id)).map((d) => {
        const otherId = d.userIds.find((id) => id !== ctx.user.id);
        const other = Object.values(db.users).find((u) => u.id === otherId);
        return { id: d.id, other: other ? publicUser(other) : { id: otherId, displayName: "Unknown" } };
      });
      return sendJson(res, 200, { dms: list });
    }

    if (pathname === "/api/dms" && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const other = db.users[email];
      if (!other) return sendJson(res, 400, { error: "No user with that email" });
      if (other.id === ctx.user.id) return sendJson(res, 400, { error: "Cannot DM yourself" });
      let dm = db.dms.find((d) => d.userIds.includes(ctx.user.id) && d.userIds.includes(other.id));
      if (!dm) {
        dm = { id: randomUUID(), userIds: [ctx.user.id, other.id], createdAt: Date.now() };
        db.dms.push(dm); save();
      }
      return sendJson(res, 200, { dm: { id: dm.id, other: publicUser(other) } });
    }

    m = pathname.match(/^\/api\/dms\/([^/]+)\/messages$/);
    if (m && req.method === "GET") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const dm = db.dms.find((d) => d.id === m[1]);
      if (!dm || !dm.userIds.includes(ctx.user.id)) return sendJson(res, 403, { error: "Forbidden" });
      const messages = db.dmMessages.filter((x) => x.dmId === dm.id && !x.deleted).sort((a, b) => a.ts - b.ts).slice(-200);
      return sendJson(res, 200, { messages });
    }

    if (m && req.method === "POST") {
      const ctx = requireUser(req, res); if (!ctx) return;
      const dm = db.dms.find((d) => d.id === m[1]);
      if (!dm || !dm.userIds.includes(ctx.user.id)) return sendJson(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const text = String(body.body || "").trim().slice(0, 2000);
      if (!text) return sendJson(res, 400, { error: "Empty" });
      const msg = {
        id: randomUUID(), dmId: dm.id, userId: ctx.user.id, authorName: ctx.user.displayName,
        body: text, ts: Date.now(), reactions: {},
      };
      db.dmMessages.push(msg); save();
      broadcast({ type: "dm_message", dmId: dm.id, message: msg }, (uid) => dm.userIds.includes(uid));
      return sendJson(res, 200, { message: msg });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || "Server error" });
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
  return serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hearth server running at http://localhost:${PORT}`);
});
