import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const ROOM = "nowcalculatrice-communal";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  max: 5
});
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "28mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const clean = (v, n = 32) => String(v ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, n);
const validSender = v => /^[a-zA-Z0-9_-]{12,80}$/.test(String(v ?? ""));
const validColor = v => /^#[0-9a-fA-F]{6}$/.test(String(v ?? ""));

async function initialize() {
  await pool.query("CREATE SCHEMA IF NOT EXISTS nowcalc_chat");
  await pool.query(`CREATE TABLE IF NOT EXISTS nowcalc_chat.chat_messages (
    id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL, sender_id TEXT NOT NULL,
    nickname VARCHAR(32) NOT NULL, color VARCHAR(7) NOT NULL,
    body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS chat_messages_room_id_id_idx ON nowcalc_chat.chat_messages(room_id,id)");
  await pool.query(`CREATE TABLE IF NOT EXISTS nowcalc_chat.chat_attachments (
    id UUID PRIMARY KEY, sender_id TEXT NOT NULL, mime TEXT NOT NULL,
    filename TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "nowcalculatrice-chat" }); }
  catch { res.status(503).json({ ok: false, error: "Database unavailable" }); }
});
app.get("/api/messages", async (req, res) => {
  const after = Math.max(0, Number(req.query.after || 0));
  if (!Number.isSafeInteger(after)) return res.status(400).json({ error: "Invalid cursor" });
  try {
    const { rows } = await pool.query(
      "SELECT id,sender_id,nickname,color,body,created_at FROM nowcalc_chat.chat_messages WHERE room_id=$1 AND id>$2 ORDER BY id ASC LIMIT 100",
      [ROOM, after]
    );
    res.json({ messages: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Lecture impossible." }); }
});
app.post("/api/messages", async (req, res) => {
  const sender = clean(req.body.sender_id, 80);
  const nickname = clean(req.body.nickname, 32) || "Participant";
  const color = validColor(req.body.color) ? req.body.color : "#1687f8";
  const body = String(req.body.body ?? "").trim();
  if (!validSender(sender) || !body || body.length > 4000) return res.status(400).json({ error: "Message ou profil invalide." });
  try {
    const { rows } = await pool.query(
      "INSERT INTO nowcalc_chat.chat_messages(room_id,sender_id,nickname,color,body) VALUES($1,$2,$3,$4,$5) RETURNING id,sender_id,nickname,color,body,created_at",
      [ROOM, sender, nickname, color, body]
    );
    res.status(201).json({ message: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: "Envoi impossible." }); }
});
app.post("/api/attachments", async (req, res) => {
  const sender = clean(req.body.sender_id, 80);
  const nickname = clean(req.body.nickname, 32) || "Participant";
  const color = validColor(req.body.color) ? req.body.color : "#1687f8";
  const mime = String(req.body.mime || "");
  const filename = clean(req.body.filename, 100) || "Fichier";
  const allowed = ["image/png","image/jpeg","image/webp","audio/webm","audio/mp4","audio/ogg","audio/mpeg","audio/wav"];
  let data;
  try { data = Buffer.from(String(req.body.data || ""), "base64"); } catch {}
  if (!validSender(sender) || !allowed.includes(mime) || !data?.length || data.length > 20 * 1024 * 1024)
    return res.status(400).json({ error: "Fichier invalide (20 Mo maximum)." });
  const id = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO nowcalc_chat.chat_attachments(id,sender_id,mime,filename,data) VALUES($1,$2,$3,$4,$5)", [id,sender,mime,filename,data]);
    const body = JSON.stringify({ __nowcalc_attachment: 1, id, mime, name: filename });
    const { rows } = await client.query(
      "INSERT INTO nowcalc_chat.chat_messages(room_id,sender_id,nickname,color,body) VALUES($1,$2,$3,$4,$5) RETURNING id,sender_id,nickname,color,body,created_at",
      [ROOM,sender,nickname,color,body]
    );
    await client.query("COMMIT");
    res.status(201).json({ message: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK"); console.error(e); res.status(500).json({ error: "Envoi du fichier impossible." });
  } finally { client.release(); }
});
app.get("/api/attachments/:id", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.sendStatus(404);
  try {
    const { rows } = await pool.query("SELECT mime,filename,data FROM nowcalc_chat.chat_attachments WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.sendStatus(404);
    res.type(rows[0].mime);
    res.setHeader("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(rows[0].filename));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(rows[0].data);
  } catch { res.sendStatus(500); }
});
app.use(express.static(root, { index: "index.html" }));
app.get("*", (_req, res) => res.sendFile(path.join(root, "index.html")));
initialize().then(() => app.listen(PORT, "0.0.0.0", () => console.log("NowCalculatrice chat listening on " + PORT)))
  .catch(e => { console.error("Database initialization failed", e); process.exit(1); });
