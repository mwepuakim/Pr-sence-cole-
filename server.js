const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';
const SCHOOL_START = process.env.SCHOOL_START || '08:00';
const LATE_GRACE_MINUTES = parseInt(process.env.LATE_GRACE_MINUTES || '15', 10);
const DEVICE_OFFLINE_AFTER_MIN = 10;
const ALLOWED_DEVICE_SN = (process.env.ALLOWED_DEVICE_SN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Base de donnees (SQLite, un seul fichier data.sqlite cree automatiquement)
// ---------------------------------------------------------------------------
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pin        TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'enseignant',
    subject    TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pin         TEXT NOT NULL,
    ts          TEXT NOT NULL,
    raw_status  TEXT,
    verify_mode TEXT,
    device_sn   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_pin_ts ON attendance(pin, ts);
  CREATE TABLE IF NOT EXISTS devices (
    sn        TEXT PRIMARY KEY,
    last_seen TEXT
  );
`);

const app = express();
app.use(
  cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    maxAge: 12 * 60 * 60 * 1000,
    sameSite: 'lax',
  })
);

// ---------------------------------------------------------------------------
// Routes ADMS / iClock : c'est ici que la pointeuse biometrique se connecte
// ---------------------------------------------------------------------------
const adms = express.Router();
adms.use(express.text({ type: '*/*', limit: '5mb' }));

function touchDevice(sn) {
  if (!sn) return;
  db.prepare(
    `INSERT INTO devices (sn, last_seen) VALUES (?, datetime('now'))
     ON CONFLICT(sn) DO UPDATE SET last_seen = excluded.last_seen`
  ).run(sn);
}
function isAllowed(sn) {
  if (ALLOWED_DEVICE_SN.length === 0) return true;
  return ALLOWED_DEVICE_SN.includes(sn);
}

adms.get('/cdata', (req, res) => {
  const sn = req.query.SN || req.query.sn;
  if (!isAllowed(sn)) return res.status(403).send('FORBIDDEN');
  touchDevice(sn);
  res.type('text/plain').send(
    [
      `GET OPTION FROM: ${sn || ''}`,
      'Stamp=0',
      'OpStamp=0',
      'ErrorDelay=30',
      'Delay=10',
      'TransTimes=00:00;23:59',
      'TransInterval=1',
      'TransFlag=1111000000',
      'Realtime=1',
      'Encrypt=0',
    ].join('\n')
  );
});

adms.post('/cdata', (req, res) => {
  const sn = req.query.SN || req.query.sn;
  const table = (req.query.table || '').toUpperCase();
  if (!isAllowed(sn)) return res.status(403).send('FORBIDDEN');
  touchDevice(sn);

  const body = typeof req.body === 'string' ? req.body : '';
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

  if (table === 'ATTLOG') {
    const insert = db.prepare(
      'INSERT INTO attendance (pin, ts, raw_status, verify_mode, device_sn) VALUES (?, ?, ?, ?, ?)'
    );
    let count = 0;
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const parts = row.split('\t');
        const pin = parts[0];
        const ts = parts[1];
        const status = parts[2];
        const verify = parts[3];
        if (!pin || !ts) continue;
        insert.run(pin, ts, status || null, verify || null, sn || null);
        count += 1;
      }
    });
    insertMany(lines);
    return res.type('text/plain').send(`OK: ${count}`);
  }
  return res.type('text/plain').send('OK');
});

adms.get('/getrequest', (req, res) => {
  const sn = req.query.SN || req.query.sn;
  if (!isAllowed(sn)) return res.status(403).send('FORBIDDEN');
  touchDevice(sn);
  res.type('text/plain').send('OK');
});

adms.post('/devicecmd', (req, res) => {
  touchDevice(req.query.SN || req.query.sn);
  res.type('text/plain').send('OK');
});
adms.post('/fdata', (req, res) => res.type('text/plain').send('OK'));
adms.get('/ping', (req, res) => res.type('text/plain').send('OK'));

app.use('/iclock', adms);

// ---------------------------------------------------------------------------
// API admin : authentification, resume du jour, gestion des enseignants
// ---------------------------------------------------------------------------
const api = express.Router();
api.use(express.json());

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Non authentifie' });
}

api.post('/login', (req, res) => {
  const password = (req.body || {}).password;
  if (password && password === ADMIN_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Mot de passe incorrect' });
});
api.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});
api.get('/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function minutesSinceMidnight(timeStr) {
  const timePart = timeStr.slice(11, 16);
  const [h, m] = timePart.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}
function computeStatus(firstPunchTs) {
  if (!firstPunchTs) return 'absent';
  const [sh, sm] = SCHOOL_START.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const punchMinutes = minutesSinceMidnight(firstPunchTs);
  if (punchMinutes === null) return 'absent';
  return punchMinutes <= startMinutes + LATE_GRACE_MINUTES ? 'present' : 'retard';
}

api.get('/today', requireAuth, (req, res) => {
  const today = todayStr();
  const teachers = db
    .prepare('SELECT id, pin, name, role, subject FROM teachers WHERE active = 1 ORDER BY name')
    .all();
  const firstPunchStmt = db.prepare('SELECT MIN(ts) as first_ts FROM attendance WHERE pin = ? AND ts LIKE ?');

  const list = teachers.map((t) => {
    const row = firstPunchStmt.get(t.pin, `${today}%`);
    const firstTs = row ? row.first_ts : null;
    return {
      id: t.id,
      name: t.name,
      role: t.role,
      subject: t.subject,
      status: computeStatus(firstTs),
      time: firstTs ? firstTs.slice(11, 16) : null,
    };
  });

  const summary = {
    total: list.length,
    present: list.filter((t) => t.status === 'present').length,
    retard: list.filter((t) => t.status === 'retard').length,
    absent: list.filter((t) => t.status === 'absent').length,
  };

  const device = db.prepare('SELECT sn, last_seen FROM devices ORDER BY last_seen DESC LIMIT 1').get();
  let deviceOnline = false;
  if (device && device.last_seen) {
    const lastSeenMs = new Date(device.last_seen + 'Z').getTime();
    deviceOnline = Date.now() - lastSeenMs < DEVICE_OFFLINE_AFTER_MIN * 60 * 1000;
  }

  res.json({ date: today, summary, teachers: list, device: device ? { ...device, online: deviceOnline } : null });
});

api.get('/teachers', requireAuth, (req, res) => {
  res.json({ teachers: db.prepare('SELECT * FROM teachers ORDER BY name').all() });
});

api.post('/teachers', requireAuth, (req, res) => {
  const body = req.body || {};
  if (!body.pin || !body.name || !body.role) {
    return res.status(400).json({ error: 'pin, name et role sont requis' });
  }
  try {
    const info = db
      .prepare('INSERT INTO teachers (pin, name, role, subject) VALUES (?, ?, ?, ?)')
      .run(String(body.pin), body.name, body.role, body.subject || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Ce PIN existe deja' });
  }
});

api.delete('/teachers/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE teachers SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.use('/api', api);

// ---------------------------------------------------------------------------
// Tableau de bord (une seule page, servie directement, pas de dossier a part)
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Presence Ecole" />
<title>Presence des enseignants</title>
<style>
:root{--bg:#f4f3ee;--surface:#fff;--border:#e3e1d9;--text:#1f1e1c;--text-muted:#6b6a63;--accent:#185fa5;--accent-bg:#e6f1fb;--success:#0f6e56;--success-bg:#e1f5ee;--warning:#854f0b;--warning-bg:#faeeda;--danger:#a32d2d;--danger-bg:#fcebeb;--radius:10px}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
.wrap{max-width:640px;margin:0 auto;padding:1.25rem 1rem 3rem}
h1,h2{font-weight:600;margin:0 0 .75rem}
h1{font-size:20px} h2{font-size:15px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em}
.hidden{display:none!important}
#login-view{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.login-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:2rem 1.5rem;width:100%;max-width:320px;text-align:center}
.login-card p{color:var(--text-muted);font-size:14px;margin-top:.25rem}
input,select,button{font:inherit}
input,select{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);margin-bottom:.75rem}
button{padding:10px 16px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer}
button.primary{background:var(--text);color:#fff;border-color:var(--text);width:100%}
button.ghost{background:transparent}
.error-text{color:var(--danger);font-size:13px;min-height:18px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem}
.topbar .date{font-size:13px;color:var(--text-muted)}
.device-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--border);color:var(--text-muted);margin-bottom:1rem}
.dot{width:8px;height:8px;border-radius:50%;background:var(--danger)}
.dot.online{background:var(--success)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:1.5rem}
.card{background:var(--surface);border-radius:var(--radius);padding:.9rem .75rem;text-align:center;border:1px solid var(--border)}
.card .num{font-size:22px;font-weight:600} .card .label{font-size:11px;color:var(--text-muted);margin-top:2px}
.card.present .num{color:var(--success)} .card.retard .num{color:var(--warning)} .card.absent .num{color:var(--danger)}
.list{background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden}
.row{display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--accent-bg);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0}
.row .info{flex:1;min-width:0} .row .name{font-size:14px;font-weight:500} .row .meta{font-size:12px;color:var(--text-muted)}
.badge{font-size:11px;padding:3px 9px;border-radius:999px;font-weight:500;flex-shrink:0}
.badge.present{background:var(--success-bg);color:var(--success)}
.badge.retard{background:var(--warning-bg);color:var(--warning)}
.badge.absent{background:var(--danger-bg);color:var(--danger)}
section{margin-bottom:1.75rem}
.add-form{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;margin-bottom:1rem}
.add-form .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.manage-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)}
.manage-row:last-child{border-bottom:none} .manage-row button{padding:6px 10px;font-size:12px}
.role-tag{font-size:11px;color:var(--text-muted)}
</style>
</head>
<body>

<div id="login-view">
  <div class="login-card">
    <h1>Presence des enseignants</h1>
    <p>Connexion administrateur</p>
    <form id="login-form" style="margin-top:1.25rem;">
      <input type="password" id="login-password" placeholder="Mot de passe" autocomplete="current-password" required />
      <div class="error-text" id="login-error"></div>
      <button type="submit" class="primary">Se connecter</button>
    </form>
  </div>
</div>

<div id="dashboard-view" class="hidden">
  <div class="wrap">
    <div class="topbar">
      <div><h1>Tableau de bord</h1><div class="date" id="today-date"></div></div>
      <button class="ghost" id="logout-btn">Deconnexion</button>
    </div>
    <div class="device-pill"><span class="dot" id="device-dot"></span><span id="device-label">Pointeuse : statut inconnu</span></div>
    <section>
      <div class="cards">
        <div class="card"><div class="num" id="stat-total">-</div><div class="label">Total</div></div>
        <div class="card present"><div class="num" id="stat-present">-</div><div class="label">Presents</div></div>
        <div class="card retard"><div class="num" id="stat-retard">-</div><div class="label">Retards</div></div>
      </div>
    </section>
    <section><h2>Aujourd'hui</h2><div class="list" id="today-list"></div></section>
    <section>
      <h2>Gerer les enseignants</h2>
      <div class="add-form">
        <form id="add-form">
          <input type="text" id="new-pin" placeholder="PIN (meme numero que sur la pointeuse)" required />
          <input type="text" id="new-name" placeholder="Nom complet" required />
          <div class="grid2">
            <select id="new-role">
              <option value="enseignant">Enseignant</option>
              <option value="direction">Direction</option>
              <option value="surveillant">Surveillant general</option>
              <option value="secretariat">Secretariat</option>
            </select>
            <input type="text" id="new-subject" placeholder="Matiere (optionnel)" />
          </div>
          <div class="error-text" id="add-error"></div>
          <button type="submit" class="primary">Ajouter</button>
        </form>
      </div>
      <div class="list" id="teacher-manage-list"></div>
    </section>
  </div>
</div>

<script>
var loginView = document.getElementById('login-view');
var dashboardView = document.getElementById('dashboard-view');
var ROLE_LABELS = { direction: 'Direction', surveillant: 'Surveillant general', secretariat: 'Secretariat', enseignant: 'Enseignant' };
var STATUS_LABELS = { present: 'Present', retard: 'Retard', absent: 'Absent' };

function initials(name) {
  var parts = name.split(' ').filter(Boolean).slice(0, 2);
  return parts.map(function (p) { return p[0].toUpperCase(); }).join('');
}

function api(url, options) {
  options = options || {};
  options.headers = { 'Content-Type': 'application/json' };
  return fetch(url, options).then(function (res) {
    if (!res.ok) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        throw new Error(body.error || ('Erreur ' + res.status));
      });
    }
    return res.json();
  });
}

function showLogin() { loginView.classList.remove('hidden'); dashboardView.classList.add('hidden'); }
function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  document.getElementById('today-date').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  loadToday();
  loadTeachers();
}

function checkSession() {
  api('/api/session').then(function (r) { if (r.authed) showDashboard(); else showLogin(); });
}

document.getElementById('login-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var password = document.getElementById('login-password').value;
  var errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  api('/api/login', { method: 'POST', body: JSON.stringify({ password: password }) })
    .then(function () { document.getElementById('login-password').value = ''; showDashboard(); })
    .catch(function (err) { errorEl.textContent = err.message; });
});

document.getElementById('logout-btn').addEventListener('click', function () {
  api('/api/logout', { method: 'POST' }).then(showLogin);
});

function loadToday() {
  api('/api/today').then(function (data) {
    document.getElementById('stat-total').textContent = data.summary.total;
    document.getElementById('stat-present').textContent = data.summary.present;
    document.getElementById('stat-retard').textContent = data.summary.retard;

    var dot = document.getElementById('device-dot');
    var label = document.getElementById('device-label');
    if (data.device) {
      dot.classList.toggle('online', data.device.online);
      label.textContent = data.device.online
        ? 'Pointeuse en ligne (' + data.device.sn + ')'
        : 'Pointeuse hors ligne depuis ' + new Date(data.device.last_seen + 'Z').toLocaleTimeString('fr-FR');
    } else {
      label.textContent = "Aucune pointeuse n'a encore contacte le serveur";
    }

    var list = document.getElementById('today-list');
    list.innerHTML = '';
    if (data.teachers.length === 0) {
      list.innerHTML = '<div class="row"><div class="meta">Aucun enseignant enregistre pour le moment.</div></div>';
      return;
    }
    data.teachers.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        '<div class="avatar">' + initials(t.name) + '</div>' +
        '<div class="info"><div class="name">' + t.name + '</div>' +
        '<div class="meta">' + (ROLE_LABELS[t.role] || t.role) + (t.subject ? ' - ' + t.subject : '') + '</div></div>' +
        '<span class="badge ' + t.status + '">' + (t.time || STATUS_LABELS[t.status]) + '</span>';
      list.appendChild(row);
    });
  });
}

function loadTeachers() {
  api('/api/teachers').then(function (data) {
    var list = document.getElementById('teacher-manage-list');
    list.innerHTML = '';
    var active = data.teachers.filter(function (t) { return t.active; });
    if (active.length === 0) {
      list.innerHTML = '<div class="manage-row"><div class="role-tag">Aucun enseignant pour le moment.</div></div>';
      return;
    }
    active.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'manage-row';
      row.innerHTML =
        '<div class="avatar">' + initials(t.name) + '</div>' +
        '<div class="info"><div class="name">' + t.name + ' <span class="role-tag">PIN ' + t.pin + '</span></div>' +
        '<div class="meta">' + (ROLE_LABELS[t.role] || t.role) + (t.subject ? ' - ' + t.subject : '') + '</div></div>' +
        '<button data-id="' + t.id + '" class="remove-btn">Retirer</button>';
      row.querySelector('.remove-btn').addEventListener('click', function () {
        if (!confirm('Retirer ' + t.name + ' de la liste ?')) return;
        api('/api/teachers/' + t.id, { method: 'DELETE' }).then(function () { loadTeachers(); loadToday(); });
      });
      list.appendChild(row);
    });
  });
}

document.getElementById('add-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var pin = document.getElementById('new-pin').value.trim();
  var name = document.getElementById('new-name').value.trim();
  var role = document.getElementById('new-role').value;
  var subject = document.getElementById('new-subject').value.trim();
  var errorEl = document.getElementById('add-error');
  errorEl.textContent = '';
  api('/api/teachers', { method: 'POST', body: JSON.stringify({ pin: pin, name: name, role: role, subject: subject }) })
    .then(function () { e.target.reset(); loadTeachers(); loadToday(); })
    .catch(function (err) { errorEl.textContent = err.message; });
});

checkSession();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Serveur pret sur le port ${PORT}`);
  console.log('Endpoint pointeuse (ADMS) : /iclock/cdata');
});
