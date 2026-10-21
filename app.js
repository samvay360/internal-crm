"use strict";
// CRM API: Express + Postgres, cookie sessions, multi-tenant.
// Exported for Vercel (api/index.js) and run locally by server.js.
//
// Tenancy: every user belongs to a tenant (a company), and every record, setting and history entry
// carries tenant_id. All reads and writes are scoped to the signed-in user's tenant. There is exactly
// one super admin (created at first-run setup); only they create tenants and user accounts, and they
// can switch which tenant they are working in.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const SESSION_DAYS = 30;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  // hosted databases (Neon, Supabase, …) need TLS; a local server usually does not
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) || /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10_000,
}) : null;
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];

/* ---------- schema ----------
 * Each entity lists its editable columns. Types: text, num, json.
 * Every entity table also gets id, tenant_id, created_by, created_at, updated_by, updated_at. */
const ENTITIES = {
  leads: {
    label: "lead",
    fields: { name: "text", company: "text", email: "text", phone: "text", region: "text", ref: "text",
      stage: "text", source: "text", value: "num", next_follow_up: "text", owner_id: "num", service: "text",
      notes: "text", client_id: "num" },
    required: ["name"],
  },
  clients: {
    label: "client",
    fields: { name: "text", company: "text", email: "text", phone: "text", region: "text", ref: "text",
      address: "text", tax_id: "text", website: "text", notes: "text", from_lead: "num" },
    required: ["name"],
  },
  projects: {
    label: "project",
    fields: { name: "text", client_id: "num", status: "text", start_date: "text", due_date: "text",
      budget: "num", owner_id: "num", description: "text", region: "text" },
    required: ["name"],
  },
  tasks: {
    label: "task",
    fields: { title: "text", project_id: "num", status: "text", priority: "text", due_date: "text",
      assignee_id: "num", description: "text" },
    required: ["title"],
  },
  quotes: {
    label: "quotation",
    fields: { number: "text", client_id: "num", project_id: "num", title: "text", ref: "text", date: "text",
      valid_until: "text", status: "text", items: "json", discount: "num", tax_rate: "num", notes: "text",
      total: "num", invoice_id: "num" },
    required: ["number", "client_id"],
    unique: "number",
  },
  invoices: {
    label: "invoice",
    fields: { number: "text", client_id: "num", project_id: "num", title: "text", ref: "text", date: "text",
      due_date: "text", status: "text", items: "json", discount: "num", tax_rate: "num", notes: "text",
      total: "num", payments: "json", from_quote: "num" },
    required: ["number", "client_id"],
    unique: "number",
  },
  expenses: {
    label: "expense",
    fields: { date: "text", amount: "num", category: "text", description: "text", vendor: "text",
      payment_method: "text", paid_by: "num", project_id: "num", notes: "text" },
    required: ["date", "amount", "description"],
  },
};
const SQL_TYPE = { text: "TEXT", num: "DOUBLE PRECISION", json: "JSONB" };
// Link fields must point at a row in the same tenant.
const LINKS = { client_id: "clients", project_id: "projects", owner_id: "users", assignee_id: "users", paid_by: "users",
  invoice_id: "invoices", from_quote: "quotes", from_lead: "leads" };

const DEFAULT_SETTINGS = {
  companyName: "", email: "", phone: "", taxId: "", address: "", website: "",
  currency: "INR", taxRate: 18, quotePrefix: "QT-", invoicePrefix: "INV-", paymentDays: 14, quoteDays: 30,
  bank: "", terms: "", logo: "", brandColor: "", docLayout: {},
  regions: ["North", "South", "East", "West", "Central"],
  leadSources: ["Website", "Referral", "Social media", "Cold outreach", "Event", "Advertising", "Other"],
  expenseCategories: ["Rent", "Salaries", "Travel", "Software & subscriptions", "Office supplies", "Utilities",
    "Marketing", "Professional fees", "Other"],
};

// Creates tables on first use, adds columns newer versions introduced, and moves data from the
// single-company version into a first tenant. Runs under an advisory lock so cold starts don't race.
async function migrate() {
  const c = await pool.connect();
  const run = (text, params) => c.query(text, params);
  try {
    await run("SELECT pg_advisory_lock(73600360)");
    await run(`
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_one_superadmin ON users (role) WHERE role = 'superadmin';
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, key TEXT NOT NULL, value JSONB NOT NULL,
  PRIMARY KEY (tenant_id, key));
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, n INTEGER NOT NULL, locked_until TEXT);
CREATE TABLE IF NOT EXISTS activity (
  id SERIAL PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL,
  summary TEXT, user_id INTEGER, at TEXT NOT NULL);
ALTER TABLE activity ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS activity_tenant ON activity (tenant_id, entity, entity_id);`);
    for (const [name, ent] of Object.entries(ENTITIES)) {
      await run(`CREATE TABLE IF NOT EXISTS ${name} (id SERIAL PRIMARY KEY,
        created_by INTEGER, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL)`);
      const cols = Object.entries(ent.fields).map(([col, t]) => `ADD COLUMN IF NOT EXISTS ${col} ${SQL_TYPE[t]}`);
      await run(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS tenant_id INTEGER, ${cols.join(", ")}`);
      await run(`CREATE INDEX IF NOT EXISTS ${name}_tenant ON ${name} (tenant_id)`);
      if (ent.unique) {
        await run(`DROP INDEX IF EXISTS ${name}_${ent.unique}`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_tenant_${ent.unique} ON ${name} (tenant_id, ${ent.unique})`);
      }
    }
    // upgrade from the single-company version: put everything into one tenant, promote the first admin
    const orphan = await run("SELECT 1 FROM users WHERE tenant_id IS NULL LIMIT 1");
    if (orphan.rows.length) {
      const old = (await run("SELECT to_regclass('public.settings') AS t")).rows[0].t;
      let name = "My company";
      if (old) {
        const r = (await run("SELECT value FROM settings WHERE key = 'companyName'")).rows[0];
        if (r?.value) name = r.value;
      }
      const t = (await run("INSERT INTO tenants (name, created_at) VALUES ($1, $2) RETURNING id", [name, now()])).rows[0].id;
      await run("UPDATE users SET tenant_id = $1 WHERE tenant_id IS NULL", [t]);
      for (const tbl of [...Object.keys(ENTITIES), "activity"]) await run(`UPDATE ${tbl} SET tenant_id = $1 WHERE tenant_id IS NULL`, [t]);
      if (old) await run("INSERT INTO tenant_settings (tenant_id, key, value) SELECT $1, key, value FROM settings ON CONFLICT DO NOTHING", [t]);
      const hasSuper = (await run("SELECT 1 FROM users WHERE role = 'superadmin'")).rows.length;
      if (!hasSuper) await run("UPDATE users SET role = 'superadmin' WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)");
    }
  } finally {
    await run("SELECT pg_advisory_unlock(73600360)").catch(() => {});
    c.release();
  }
}
let ready = null;
const ensureReady = () => (ready ??= migrate().catch(e => { ready = null; throw e; }));

// Quotation/invoice layout chosen in Settings → Documents. Only known options are stored.
const LAYOUT_SPEC = {
  template: ["classic", "band", "minimal", "gst"], font: ["sans", "serif", "plain"], paper: ["A4", "Letter"],
  taxDisplay: ["single", "cgst_sgst", "igst"],
  invoiceTitle: 60, quoteTitle: 60, signatureLabel: 80, footer: 300,
  showLogo: true, showSellerGstin: true, showBuyerGstin: true, showHsn: true,
  showWords: true, showBank: true, showNotes: true, showSignature: true,
};
function cleanLayout(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, spec] of Object.entries(LAYOUT_SPEC)) {
    if (!(k in v)) continue;
    if (Array.isArray(spec)) { if (spec.includes(v[k])) out[k] = v[k]; }
    else if (typeof spec === "number") out[k] = String(v[k] ?? "").slice(0, spec);
    else out[k] = !!v[k];
  }
  if (typeof v.accent === "string" && /^(#[0-9a-f]{6})?$/i.test(v.accent)) out.accent = v.accent;
  return out;
}

/* ---------- helpers ---------- */
function now() { return new Date().toISOString(); }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split("$");
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}
async function getSettings(tenantId) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of await q("SELECT key, value FROM tenant_settings WHERE tenant_id = $1", [tenantId])) out[r.key] = r.value;
  if (!out.companyName) out.companyName = (await one("SELECT name FROM tenants WHERE id = $1", [tenantId]))?.name || "";
  return out;
}
const putSetting = (tenantId, key, value) =>
  q(`INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`, [tenantId, key, JSON.stringify(value)]);
function rowOut(entity, row) {
  if (!row) return row;
  const out = { ...row };
  for (const [col, type] of Object.entries(ENTITIES[entity].fields)) if (type === "json") out[col] = row[col] || [];
  return out;
}
function clean(entity, body) {
  const out = {};
  for (const [col, type] of Object.entries(ENTITIES[entity].fields)) {
    if (!(col in body)) continue;
    let v = body[col];
    if (type === "num") v = v === "" || v == null ? null : Number(v);
    if (type === "num" && v != null && !Number.isFinite(v)) throw httpError(400, `${col} must be a number`);
    if (type === "text") v = v == null ? null : String(v).trim().slice(0, 20000);
    if (type === "json") v = JSON.stringify(Array.isArray(v) ? v : []);
    out[col] = v;
  }
  return out;
}
async function checkLinks(values, tenantId) {
  for (const [col, table] of Object.entries(LINKS)) {
    if (values[col] == null) continue;
    const hit = await one(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`, [values[col], tenantId]);
    if (!hit) throw httpError(400, `The selected ${col.replace(/_id$|^from_/g, "").replace(/_/g, " ")} was not found.`);
  }
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const logActivity = (tenantId, entity, entityId, action, summary, userId) =>
  q("INSERT INTO activity (tenant_id, entity, entity_id, action, summary, user_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [tenantId, entity, entityId, action, summary || null, userId, now()]);
const describe = rec => rec.name || rec.title || rec.number || rec.description || `#${rec.id}`;

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

app.use("/api", async (req, res, next) => {
  if (!pool) return res.status(500).json({ error: "The database is not configured. Set DATABASE_URL (see README)." });
  try { await ensureReady(); } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not connect to the database. Check DATABASE_URL." });
  }
  // Reject cross-site writes (CSRF): browsers send Origin on POST/PUT/DELETE.
  if (req.method !== "GET" && req.headers.origin) {
    let host = ""; try { host = new URL(req.headers.origin).host; } catch {}
    if (host !== req.headers.host) return res.status(403).json({ error: "Cross-site request blocked." });
  }
  next();
});

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  res.set("Set-Cookie", `crm_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${req.secure ? "; Secure" : ""}`);
}
// The signed-in user, with tenantId = the tenant they are working in (a super admin may have switched).
async function currentUser(req) {
  const token = parseCookies(req).crm_session;
  if (!token) return null;
  const row = await one(`SELECT u.id, u.name, u.email, u.role, u.active, u.tenant_id, t.active AS tenant_active,
      s.expires_at, s.tenant_id AS session_tenant
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id WHERE s.token = $1`, [token]);
  if (!row || !row.active || row.expires_at < now()) return null;
  const isSuper = row.role === "superadmin";
  if (!isSuper && !row.tenant_active) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, homeTenantId: row.tenant_id,
    tenantId: isSuper && row.session_tenant ? row.session_tenant : row.tenant_id, token };
}
async function requireUser(req, res, next) {
  req.user = await currentUser(req);
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  req.tenantId = req.user.tenantId;
  next();
}
const isSuper = req => req.user.role === "superadmin";
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin" && !isSuper(req)) return res.status(403).json({ error: "Only administrators can do this." });
  next();
}
function requireSuper(req, res, next) {
  if (!isSuper(req)) return res.status(403).json({ error: "Only the super admin can manage accounts." });
  next();
}

/* auth */
const userCount = async () => Number((await one("SELECT COUNT(*) AS n FROM users")).n);
app.get("/api/status", async (req, res) => {
  const user = await currentUser(req);
  // before sign-in, show the branding of the super admin's company
  const home = user?.tenantId || (await one("SELECT tenant_id FROM users WHERE role = 'superadmin'"))?.tenant_id;
  const s = home ? await getSettings(home) : DEFAULT_SETTINGS;
  res.json({ needsSetup: (await userCount()) === 0, user: user && { id: user.id, name: user.name, role: user.role },
    companyName: s.companyName, logo: s.logo, brandColor: s.brandColor });
});
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await q("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)", [token, userId, expires]);
  await q("DELETE FROM sessions WHERE expires_at < $1", [now()]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}
function validateNewUser({ name, email, password }) {
  if (!name || !String(name).trim()) throw httpError(400, "Enter a name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ""))) throw httpError(400, "Enter a valid email address.");
  if (!password || String(password).length < 8) throw httpError(400, "Use a password of at least 8 characters.");
}
// First run: create the first tenant and the one super admin.
app.post("/api/setup", async (req, res) => {
  if ((await userCount()) > 0) return res.status(409).json({ error: "Setup is already complete. Please sign in." });
  const { name, email, password, companyName } = req.body || {};
  validateNewUser({ name, email, password });
  const t = await one("INSERT INTO tenants (name, created_at) VALUES ($1, $2) RETURNING id", [String(companyName || "").trim() || "My company", now()]);
  const u = await one(`INSERT INTO users (tenant_id, name, email, password_hash, role, created_at)
    VALUES ($1,$2,$3,$4,'superadmin',$5) RETURNING id`,
    [t.id, String(name).trim(), String(email).trim().toLowerCase(), hashPassword(String(password)), now()]);
  if (companyName) await putSetting(t.id, "companyName", String(companyName).trim());
  await startSession(req, res, u.id);
  res.json({ ok: true });
});
// Failed sign-ins are counted in the database so the limit holds across serverless instances.
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const mail = String(email || "").trim().toLowerCase();
  const key = `${req.ip}|${mail}`;
  const a = await one("SELECT n, locked_until FROM login_attempts WHERE key = $1", [key]);
  if (a?.locked_until && a.locked_until > now()) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  const u = await one(`SELECT u.*, t.active AS tenant_active FROM users u JOIN tenants t ON t.id = u.tenant_id
    WHERE lower(u.email) = $1`, [mail]);
  if (!u || !u.active || !checkPassword(String(password || ""), u.password_hash)) {
    const n = (a?.n || 0) + 1;
    const lock = n >= 8 ? new Date(Date.now() + 10 * 60e3).toISOString() : null;
    await q(`INSERT INTO login_attempts (key, n, locked_until) VALUES ($1,$2,$3)
      ON CONFLICT (key) DO UPDATE SET n = EXCLUDED.n, locked_until = EXCLUDED.locked_until`, [key, lock ? 0 : n, lock]);
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (!u.tenant_active && u.role !== "superadmin") return res.status(403).json({ error: "Your company's account is disabled. Contact your administrator." });
  await q("DELETE FROM login_attempts WHERE key = $1", [key]);
  await startSession(req, res, u.id);
  res.json({ ok: true });
});
app.post("/api/logout", async (req, res) => {
  const token = parseCookies(req).crm_session;
  if (token) await q("DELETE FROM sessions WHERE token = $1", [token]);
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
});

/* everything below requires a signed-in user */
app.use("/api", requireUser);

app.get("/api/bootstrap", async (req, res) => {
  const data = {};
  await Promise.all(Object.keys(ENTITIES).map(async name => {
    data[name] = (await q(`SELECT * FROM ${name} WHERE tenant_id = $1 ORDER BY id DESC`, [req.tenantId])).map(r => rowOut(name, r));
  }));
  // people in this tenant (for owners, assignees and "added by"); the super admin is listed in every tenant
  const users = await q(`SELECT id, name, email, role, active, tenant_id FROM users
    WHERE tenant_id = $1 OR role = 'superadmin' ORDER BY name`, [req.tenantId]);
  const tenant = await one("SELECT id, name, active FROM tenants WHERE id = $1", [req.tenantId]);
  const { token, ...me } = req.user;
  res.json({ me, tenant, settings: await getSettings(req.tenantId), users, data });
});

app.get("/api/activity/:entity/:id", async (req, res) => {
  if (!ENTITIES[req.params.entity]) return res.status(404).json({ error: "Unknown record type." });
  res.json(await q("SELECT * FROM activity WHERE tenant_id = $1 AND entity = $2 AND entity_id = $3 ORDER BY id DESC LIMIT 100",
    [req.tenantId, req.params.entity, Number(req.params.id)]));
});
app.get("/api/activity", async (req, res) => {
  res.json(await q("SELECT * FROM activity WHERE tenant_id = $1 ORDER BY id DESC LIMIT 40", [req.tenantId]));
});

/* company settings: tenant admins and the super admin */
app.put("/api/settings", requireAdmin, async (req, res) => {
  const body = req.body || {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in body)) continue;
    let v = body[key];
    if (key === "logo" && v && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(v)) throw httpError(400, "Logo must be a PNG, JPG, WebP or SVG image.");
    if (key === "logo" && v && v.length > 1_500_000) throw httpError(400, "Logo is too large. Use an image under 1 MB.");
    if (key === "brandColor" && v && !/^#[0-9a-f]{6}$/i.test(v)) throw httpError(400, "Brand colour must be a hex value like #b8652c.");
    if (key === "docLayout") v = cleanLayout(v);
    if (Array.isArray(DEFAULT_SETTINGS[key])) v = (Array.isArray(v) ? v : []).map(s => String(s).trim()).filter(Boolean).slice(0, 200);
    await putSetting(req.tenantId, key, v);
  }
  if (body.companyName) await q("UPDATE tenants SET name = $1 WHERE id = $2", [String(body.companyName).trim(), req.tenantId]);
  res.json(await getSettings(req.tenantId));
});

/* own account: anyone can change their name and password */
app.put("/api/me", async (req, res) => {
  const { name, password, currentPassword } = req.body || {};
  if (name != null && String(name).trim()) await q("UPDATE users SET name = $1 WHERE id = $2", [String(name).trim(), req.user.id]);
  if (password) {
    if (String(password).length < 8) throw httpError(400, "Use a password of at least 8 characters.");
    const u = await one("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    if (!checkPassword(String(currentPassword || ""), u.password_hash)) throw httpError(400, "Your current password is incorrect.");
    await q("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(String(password)), req.user.id]);
    await q("DELETE FROM sessions WHERE user_id = $1 AND token <> $2", [req.user.id, req.user.token]);
  }
  res.json({ ok: true });
});

/* super admin: tenants and accounts */
app.get("/api/admin/tenants", requireSuper, async (req, res) => {
  res.json(await q(`SELECT t.id, t.name, t.active, t.created_at,
      (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
      (SELECT COUNT(*)::int FROM leads l WHERE l.tenant_id = t.id) AS leads
    FROM tenants t ORDER BY t.name`));
});
app.post("/api/admin/tenants", requireSuper, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) throw httpError(400, "Enter the company name.");
  const t = await one("INSERT INTO tenants (name, created_at) VALUES ($1, $2) RETURNING id", [name, now()]);
  await putSetting(t.id, "companyName", name);
  res.status(201).json({ id: t.id });
});
app.put("/api/admin/tenants/:id", requireSuper, async (req, res) => {
  const id = Number(req.params.id);
  const t = await one("SELECT * FROM tenants WHERE id = $1", [id]);
  if (!t) return res.status(404).json({ error: "Tenant not found." });
  const { name, active } = req.body || {};
  if (name != null && String(name).trim()) {
    await q("UPDATE tenants SET name = $1 WHERE id = $2", [String(name).trim(), id]);
    await putSetting(id, "companyName", String(name).trim());
  }
  if (active != null) {
    if (!active && id === req.user.homeTenantId) throw httpError(400, "You can't disable your own company.");
    await q("UPDATE tenants SET active = $1 WHERE id = $2", [!!active, id]);
  }
  res.json({ ok: true });
});
app.post("/api/admin/switch", requireSuper, async (req, res) => {
  const id = Number(req.body?.tenant_id);
  if (!(await one("SELECT 1 FROM tenants WHERE id = $1", [id]))) throw httpError(404, "Tenant not found.");
  await q("UPDATE sessions SET tenant_id = $1 WHERE token = $2", [id, req.user.token]);
  res.json({ ok: true });
});
app.get("/api/admin/users", requireSuper, async (req, res) => {
  res.json(await q(`SELECT u.id, u.name, u.email, u.role, u.active, u.tenant_id, t.name AS tenant_name, u.created_at,
      (SELECT COUNT(*)::int FROM leads l WHERE l.created_by = u.id) AS leads_added
    FROM users u JOIN tenants t ON t.id = u.tenant_id ORDER BY t.name, u.name`));
});
app.post("/api/admin/users", requireSuper, async (req, res) => {
  const { name, email, password, role, tenant_id } = req.body || {};
  validateNewUser({ name, email, password });
  const tid = Number(tenant_id);
  if (!(await one("SELECT 1 FROM tenants WHERE id = $1", [tid]))) throw httpError(400, "Choose the company this person belongs to.");
  const mail = String(email).trim().toLowerCase();
  if (await one("SELECT id FROM users WHERE lower(email) = $1", [mail])) throw httpError(409, "Someone with this email already has an account.");
  const u = await one(`INSERT INTO users (tenant_id, name, email, password_hash, role, created_at)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tid, String(name).trim(), mail, hashPassword(String(password)), role === "admin" ? "admin" : "member", now()]);
  res.status(201).json({ id: u.id });
});
app.put("/api/admin/users/:id", requireSuper, async (req, res) => {
  const id = Number(req.params.id);
  const u = await one("SELECT * FROM users WHERE id = $1", [id]);
  if (!u) return res.status(404).json({ error: "User not found." });
  if (u.role === "superadmin" && id !== req.user.id) throw httpError(403, "The super admin account can't be changed here.");
  const { name, role, active, password, tenant_id } = req.body || {};
  if (name != null && String(name).trim()) await q("UPDATE users SET name = $1 WHERE id = $2", [String(name).trim(), id]);
  if (u.role !== "superadmin") {
    if (role) await q("UPDATE users SET role = $1 WHERE id = $2", [role === "admin" ? "admin" : "member", id]);
    if (tenant_id != null) {
      if (!(await one("SELECT 1 FROM tenants WHERE id = $1", [Number(tenant_id)]))) throw httpError(400, "Tenant not found.");
      await q("UPDATE users SET tenant_id = $1 WHERE id = $2", [Number(tenant_id), id]);
    }
    if (active != null) {
      await q("UPDATE users SET active = $1 WHERE id = $2", [!!active, id]);
      if (!active) await q("DELETE FROM sessions WHERE user_id = $1", [id]);
    }
  }
  if (password) {
    if (String(password).length < 8) throw httpError(400, "Use a password of at least 8 characters.");
    await q("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(String(password)), id]);
    await q("DELETE FROM sessions WHERE user_id = $1", [id]);
  }
  res.json({ ok: true });
});

/* records: leads, clients, projects, tasks, quotes, invoices — always scoped to req.tenantId */
function entityGuard(req, res, next) {
  req.ent = ENTITIES[req.params.entity];
  if (!req.ent) return res.status(404).json({ error: "Unknown record type." });
  next();
}
async function uniqueCheck(req, entity, values, exceptId) {
  const col = ENTITIES[entity].unique;
  if (!col || values[col] == null) return;
  const hit = await one(`SELECT id FROM ${entity} WHERE tenant_id = $1 AND ${col} = $2 AND id <> $3`, [req.tenantId, values[col], exceptId || 0]);
  if (hit) throw httpError(409, `${values[col]} is already used. Choose another number.`);
}

app.post("/api/:entity", entityGuard, async (req, res) => {
  const entity = req.params.entity;
  const values = clean(entity, req.body || {});
  for (const f of req.ent.required) if (values[f] == null || values[f] === "") throw httpError(400, `${f.replace(/_/g, " ")} is required.`);
  await checkLinks(values, req.tenantId);
  await uniqueCheck(req, entity, values);
  const t = now();
  const cols = [...Object.keys(values), "tenant_id", "created_by", "created_at", "updated_by", "updated_at"];
  const vals = [...Object.values(values), req.tenantId, req.user.id, t, req.user.id, t];
  const rec = rowOut(entity, await one(`INSERT INTO ${entity} (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`, vals));
  await logActivity(req.tenantId, entity, rec.id, "created", `Added ${req.ent.label} ${describe(rec)}`, req.user.id);
  res.status(201).json(rec);
});

app.put("/api/:entity/:id", entityGuard, async (req, res) => {
  const entity = req.params.entity, id = Number(req.params.id);
  const before = await one(`SELECT * FROM ${entity} WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
  if (!before) return res.status(404).json({ error: "This record no longer exists." });
  const values = clean(entity, req.body || {});
  for (const f of req.ent.required) if (f in values && (values[f] == null || values[f] === "")) throw httpError(400, `${f.replace(/_/g, " ")} is required.`);
  await checkLinks(values, req.tenantId);
  await uniqueCheck(req, entity, values, id);
  const cols = Object.keys(values);
  const n = cols.length;
  const sets = [...cols.map((c, i) => `${c} = $${i + 1}`), `updated_by = $${n + 1}`, `updated_at = $${n + 2}`];
  const rec = rowOut(entity, await one(`UPDATE ${entity} SET ${sets.join(", ")} WHERE id = $${n + 3} AND tenant_id = $${n + 4} RETURNING *`,
    [...Object.values(values), req.user.id, now(), id, req.tenantId]));
  // record what changed in plain words for the history panel
  const changed = cols.filter(c => ENTITIES[entity].fields[c] !== "json" && String(before[c] ?? "") !== String(rec[c] ?? ""));
  let summary = `Updated ${describe(rec)}`;
  if (changed.includes("stage")) summary = `Moved ${describe(rec)} to ${rec.stage}`;
  else if (changed.includes("status")) summary = `Changed status of ${describe(rec)} to ${rec.status}`;
  else if (changed.length) summary += ` (${changed.map(c => c.replace(/_/g, " ")).join(", ")})`;
  if (req.body?._activity) summary = String(req.body._activity).slice(0, 300);
  await logActivity(req.tenantId, entity, id, "updated", summary, req.user.id);
  res.json(rec);
});

app.delete("/api/:entity/:id", entityGuard, async (req, res) => {
  const entity = req.params.entity, id = Number(req.params.id);
  const rec = await one(`SELECT * FROM ${entity} WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
  if (!rec) return res.json({ ok: true });
  if (req.user.role === "member" && rec.created_by !== req.user.id) {
    return res.status(403).json({ error: "Only an administrator or the person who added this record can delete it." });
  }
  await q(`DELETE FROM ${entity} WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
  await logActivity(req.tenantId, entity, id, "deleted", `Deleted ${req.ent.label} ${describe(rec)}`, req.user.id);
  res.json({ ok: true });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

/* static frontend (on Vercel, public/ is served by the CDN and never reaches this) */
app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That upload is too large." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again." });
});

module.exports = app;
