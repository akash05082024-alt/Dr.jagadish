'use strict';
/**
 * Clinic booking server – zero dependencies (Node 18+).
 * - Public: view free slots, request an appointment (slot is held immediately)
 * - Admin: login (ID + password), see/confirm/cancel bookings, block slots
 * - Optional: automatic SMS / WhatsApp to the admin number via Twilio
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- tiny .env loader ----------
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (_) { /* no .env file */ }

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_ID = process.env.ADMIN_ID || 'drray-admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '918777019294').replace(/\D/g, '');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_HOURS = 12;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('ERROR: set ADMIN_PASSWORD (min 8 characters) in .env or the environment.');
  process.exit(1);
}

const CONFIG = {
  daysAhead: 14,
  slotMinutes: 30,
  sessions: [
    { label: 'Morning', start: '10:00', end: '13:00' },
    { label: 'Evening', start: '17:00', end: '20:00' },
  ],
};

// ---------- time helpers (clinic is in India, IST) ----------
const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); };
const fromMin = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);

function nowIST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const o = {};
  parts.forEach((p) => { o[p.type] = p.value; });
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}
function validDates() {
  const t = nowIST().date.split('-').map(Number);
  const out = [];
  for (let i = 0; i < CONFIG.daysAhead; i++) {
    out.push(new Date(Date.UTC(t[0], t[1] - 1, t[2] + i)).toISOString().slice(0, 10));
  }
  return out;
}
function allSlotTimes() {
  const out = [];
  CONFIG.sessions.forEach((s) => {
    for (let m = toMin(s.start); m + CONFIG.slotMinutes <= toMin(s.end); m += CONFIG.slotMinutes) out.push(fromMin(m));
  });
  return out;
}
function fmt12(t) {
  const m = toMin(t); let h = Math.floor(m / 60); const mm = m % 60;
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${pad(mm)} ${ap}`;
}
function isPast(date, time) {
  const n = nowIST();
  return date === n.date && toMin(time) <= n.minutes;
}

// ---------- storage (JSON file, atomic writes) ----------
let db = { bookings: [], blocked: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (_) { /* first run */ }
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
const isActive = (b) => b.status === 'pending' || b.status === 'confirmed';
function slotTaken(date, time) {
  if (db.blocked[date] && time in db.blocked[date]) return true;
  return db.bookings.some((b) => isActive(b) && b.date === date && b.time === time);
}

// ---------- notifications (Twilio, optional) ----------
async function notifyAdmin(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    console.log(`[notify skipped – Twilio not configured] to +${ADMIN_PHONE}:\n${text}\n`);
    return false;
  }
  const wa = from.startsWith('whatsapp:');
  const to = (wa ? 'whatsapp:+' : '+') + ADMIN_PHONE;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }).toString(),
    });
    if (!r.ok) { console.error('Twilio error', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('Twilio request failed', e.message); return false; }
}

// ---------- auth ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'); }
function makeToken() {
  const p = b64u(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600 * 1000 }));
  return p + '.' + sign(p);
}
function tokenOk(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return false;
  const [p, s] = tok.split('.');
  const good = sign(p);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch (_) { return false; }
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- rate limiting ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  h.n += 1;
  return h.n > max;
}
setInterval(() => { const n = Date.now(); hits.forEach((v, k) => { if (v.reset < n) hits.delete(k); }); }, 600000).unref();
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------- http helpers ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};
function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || !MIME[path.extname(name)]) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, 'public', name), (err, buf) => {
    if (err) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(name)], 'Cache-Control': 'no-cache' }, SEC_HEADERS));
    res.end(buf);
  });
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname, m = req.method;

  if (m === 'GET' && p === '/api/config') {
    return send(res, 200, { slotMinutes: CONFIG.slotMinutes, sessions: CONFIG.sessions, dates: validDates(), adminPhone: ADMIN_PHONE });
  }

  if (m === 'GET' && p === '/api/slots') {
    const date = url.searchParams.get('date');
    if (!validDates().includes(date)) return send(res, 400, { error: 'Invalid date' });
    const unavailable = allSlotTimes().filter((t) => isPast(date, t) || slotTaken(date, t));
    return send(res, 200, { date, unavailable });
  }

  if (m === 'POST' && p === '/api/book') {
    if (limited('book:' + clientIp(req), 10, 3600000)) return send(res, 429, { error: 'Too many requests. Please try again later.' });
    const b = await readBody(req);
    const name = clean(b.name, 80), reason = clean(b.reason, 200), date = clean(b.date, 10), time = clean(b.time, 5);
    let phone = String(b.phone || '').replace(/\D/g, '').replace(/^(91|0)/, '');
    if (name.length < 2) return send(res, 400, { error: "Please enter the patient's name." });
    if (phone.length !== 10) return send(res, 400, { error: 'Please enter a valid 10-digit mobile number.' });
    if (!validDates().includes(date) || !allSlotTimes().includes(time)) return send(res, 400, { error: 'Invalid date or time.' });
    if (isPast(date, time)) return send(res, 409, { error: 'That time has already passed.' });
    if (slotTaken(date, time)) return send(res, 409, { error: 'Sorry, that slot was just taken. Please choose another.' });
    const booking = {
      id: crypto.randomBytes(6).toString('hex'), date, time, name, phone, reason,
      status: 'pending', createdAt: new Date().toISOString(),
    };
    db.bookings.push(booking);
    save();
    const text = `New appointment request\nName: ${name}\nPhone: ${phone}\nDate: ${date}\nTime: ${fmt12(time)}${reason ? '\nReason: ' + reason : ''}\nOpen the admin panel to confirm.`;
    notifyAdmin(text).catch(() => {});
    return send(res, 200, { ok: true, id: booking.id, date, time, name });
  }

  if (m === 'POST' && p === '/api/admin/login') {
    const ip = clientIp(req);
    if (limited('login:' + ip, 5, 15 * 60000)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const b = await readBody(req);
    const ok = safeEqual(b.id || '', ADMIN_ID) & safeEqual(b.password || '', ADMIN_PASSWORD);
    if (!ok) return send(res, 401, { error: 'Incorrect ID or password.' });
    return send(res, 200, { token: makeToken() });
  }

  if (p.startsWith('/api/admin/')) {
    const auth = req.headers.authorization || '';
    if (!tokenOk(auth.startsWith('Bearer ') ? auth.slice(7) : '')) return send(res, 401, { error: 'Please log in again.' });

    if (m === 'GET' && p === '/api/admin/bookings') {
      const today = nowIST().date;
      const bookings = db.bookings
        .filter((b) => b.date >= today && isActive(b))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return send(res, 200, { bookings, blocked: db.blocked });
    }

    const mm = p.match(/^\/api\/admin\/booking\/([a-f0-9]+)$/);
    if (m === 'POST' && mm) {
      const b = await readBody(req);
      const bk = db.bookings.find((x) => x.id === mm[1]);
      if (!bk) return send(res, 404, { error: 'Booking not found' });
      if (!['confirmed', 'cancelled'].includes(b.status)) return send(res, 400, { error: 'Invalid status' });
      bk.status = b.status; bk.updatedAt = new Date().toISOString();
      save();
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/admin/block') {
      const b = await readBody(req);
      const date = clean(b.date, 10), time = clean(b.time, 5);
      if (!validDates().includes(date) || !allSlotTimes().includes(time)) return send(res, 400, { error: 'Invalid date or time.' });
      if (b.blocked) {
        if (slotTaken(date, time)) return send(res, 409, { error: 'That slot is already taken.' });
        db.blocked[date] = db.blocked[date] || {};
        db.blocked[date][time] = clean(b.note, 60) || 'Blocked';
      } else if (db.blocked[date]) {
        delete db.blocked[date][time];
        if (!Object.keys(db.blocked[date]).length) delete db.blocked[date];
      }
      save();
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC_HEADERS); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) send(res, e.message === 'too large' ? 413 : 400, { error: 'Bad request' });
  }
}).listen(PORT, () => console.log(`Clinic booking running on http://localhost:${PORT}`));
