// BISONTECH: servidor.
// Recibe lecturas (del collar o del simulador), las guarda en SQLite y sirve la web.
// Requiere Node.js 22.5 o superior. No necesita instalar dependencias.
//
// Uso:
//   node server.js          -> servidor, esperando lecturas reales del collar
//   node server.js --sim    -> servidor + simulador de 5 bisontes

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const SIM = process.argv.includes('--sim');
const TICK_MS = 5000;
const CENTER = [40.752802421187845, -3.8113048447402043];
// Si pasan más de 10 min entre dos lecturas, se considera que el collar no funcionaba
const MAX_GAP_MS = 10 * 60e3;

// ---------- Base de datos ----------
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'bisontes.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS lecturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    animal INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    bateria REAL,
    temperatura REAL,
    actividad TEXT,
    dentro INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_animal_ts ON lecturas(animal, ts);
  CREATE TABLE IF NOT EXISTS zona (id INTEGER PRIMARY KEY CHECK (id = 1), puntos TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS prohibidas (id INTEGER PRIMARY KEY AUTOINCREMENT, puntos TEXT NOT NULL, creada INTEGER);
`);

const insertStmt = db.prepare(
  'INSERT INTO lecturas (animal, ts, lat, lng, bateria, temperatura, actividad, dentro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const latestStmt = db.prepare(`
  SELECT l.* FROM lecturas l
  JOIN (SELECT animal, MAX(ts) AS m FROM lecturas GROUP BY animal) x
    ON l.animal = x.animal AND l.ts = x.m
  ORDER BY l.animal`);
const historyStmt = db.prepare(
  'SELECT ts, lat, lng, bateria, temperatura, actividad, dentro FROM lecturas WHERE animal = ? AND ts >= ? ORDER BY ts'
);
const zonaGet = db.prepare('SELECT puntos FROM zona WHERE id = 1');
const zonaSet = db.prepare(
  'INSERT INTO zona (id, puntos) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET puntos = excluded.puntos'
);
const zonaDel = db.prepare('DELETE FROM zona WHERE id = 1');
const prohGetAll = db.prepare('SELECT id, puntos FROM prohibidas ORDER BY id');
const prohAdd = db.prepare('INSERT INTO prohibidas (puntos, creada) VALUES (?, ?)');
const prohDelAll = db.prepare('DELETE FROM prohibidas');
const prohDel = db.prepare('DELETE FROM prohibidas WHERE id = ?');
const allStmt = db.prepare('SELECT animal, ts, lat, lng FROM lecturas WHERE ts >= ? ORDER BY ts');

// ---------- Geografía ----------
function getZona() {
  const row = zonaGet.get();
  return row ? JSON.parse(row.puntos) : null;
}

function getProhibidas() {
  return prohGetAll.all().map(r => ({ id: r.id, puntos: JSON.parse(r.puntos) }));
}

function esPoligono(p) {
  return Array.isArray(p) && p.length >= 3 &&
    p.every(x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite));
}

function estaDentro(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroide(z) {
  const lat = z.reduce((s, p) => s + p[0], 0) / z.length;
  const lng = z.reduce((s, p) => s + p[1], 0) / z.length;
  return estaDentro(lat, lng, z) ? [lat, lng] : z[0];
}

function distanciaM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Altura del sol sobre el horizonte en la finca (seno del ángulo). > 0 = de día.
// Cálculo solar (NOAA simplificado) en UTC: no depende de la zona horaria del servidor.
function sinElevacion(ts) {
  const rad = x => x * Math.PI / 180;
  const d = new Date(ts);
  const dayStart = Date.UTC(d.getUTCFullYear(), 0, 0);
  const N = (ts - dayStart) / 86400000;
  const g = 2 * Math.PI * (N - 1) / 365;
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const minUTC = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const tst = minUTC + eqt + 4 * CENTER[1];
  const ha = rad(tst / 4 - 180);
  const lat = rad(CENTER[0]);
  return Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
}

// ---------- Guardar y estadísticas ----------
function guardar(l) {
  const zona = getZona();
  const dentro = zona ? (estaDentro(l.lat, l.lng, zona) ? 1 : 0) : 1;
  insertStmt.run(l.animal, l.ts, l.lat, l.lng, l.bateria, l.temperatura, l.actividad, dentro);
}

function estadisticas(id, horas) {
  const rows = historyStmt.all(id, Date.now() - horas * 3600e3);
  let km = 0, minDentro = 0, minFuera = 0, minFunc = 0;
  const actividad = {};
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], r = rows[i];
    const dt = r.ts - p.ts;
    if (dt > MAX_GAP_MS) continue; // hueco sin lecturas: el collar no informaba
    const min = dt / 60000;
    minFunc += min;
    km += distanciaM(p, r) / 1000;
    if (p.dentro) minDentro += min; else minFuera += min;
    const act = p.actividad || 'Sin dato';
    actividad[act] = (actividad[act] || 0) + min;
  }
  const bats = rows.map(r => r.bateria).filter(v => v != null);
  const temps = rows.map(r => r.temperatura).filter(v => v != null);
  return {
    lecturas: rows.length,
    distanciaKm: +km.toFixed(2),
    minutosDentro: Math.round(minDentro),
    minutosFuera: Math.round(minFuera),
    minutosFuncionando: Math.round(minFunc),
    bateriaMin: bats.length ? Math.min(...bats) : null,
    bateriaMax: bats.length ? Math.max(...bats) : null,
    temperaturaMedia: temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null,
    actividad: Object.fromEntries(Object.entries(actividad).map(([k, v]) => [k, Math.round(v)]))
  };
}

// ---------- Simulador ----------
const K = Math.cos(CENTER[0] * Math.PI / 180);
const CELL_LAT = 0.000045;        // celdas de unos 5 m
const CELL_LNG = 0.000045 / K;
const CELDA_M2 = 25;
const WALK = 0.00005;             // paso al caminar (~5 m cada 5 s)
const GRAZE = 0.00001;            // paso al pastar (~1 m cada 5 s)

const sim = [1, 2, 3, 4, 5].map(id => ({
  id,
  lat: CENTER[0] + (Math.random() - 0.5) * 0.002,
  lng: CENTER[1] + (Math.random() - 0.5) * 0.003,
  bat: 40 + Math.random() * 50,
  temp: 38.5,
  act: 'Pastando',
  h: Math.random() * 2 * Math.PI,
  pasto: null,
  hastaCambio: 0,
  escaping: false
}));

const angulo = (dLat, dLng) => Math.atan2(dLat, dLng * K);
const normal = a => Math.atan2(Math.sin(a), Math.cos(a));

// Un punto de pasto cerca de donde está (10-35 m), dentro de la zona azul y fuera de las rojas
function puntoCerca(b, zona, enRoja) {
  for (let i = 0; i < 30; i++) {
    const r = (10 + Math.random() * 25) / 111000;
    const a = Math.random() * 2 * Math.PI;
    const la = b.lat + Math.sin(a) * r;
    const lo = b.lng + Math.cos(a) * r / K;
    if (estaDentro(la, lo, zona) && !enRoja(la, lo)) return [la, lo];
  }
  return null;
}

function puntoAleatorio(zona, enRoja) {
  const la0 = Math.min(...zona.map(p => p[0])), la1 = Math.max(...zona.map(p => p[0]));
  const lo0 = Math.min(...zona.map(p => p[1])), lo1 = Math.max(...zona.map(p => p[1]));
  for (let i = 0; i < 200; i++) {
    const la = la0 + Math.random() * (la1 - la0);
    const lo = lo0 + Math.random() * (lo1 - lo0);
    if (estaDentro(la, lo, zona) && !enRoja(la, lo)) return [la, lo];
  }
  return null;
}

// Avanza un paso probando el rumbo previsto y, si no vale, rumbos cercanos.
// Nunca entra en una zona roja. Dentro de la azul, no sale salvo que se le permita.
function paso(b, velocidad, zona, enRoja, puedeSalir, huir) {
  const dist = (la, lo) => Math.hypot(la - huir[0], (lo - huir[1]) * K);
  for (let k = 0; k <= 8; k++) {
    for (const s of k === 0 ? [0] : [1, -1]) {
      const a = b.h + s * k * 0.35;
      const la = b.lat + Math.sin(a) * velocidad;
      const lo = b.lng + Math.cos(a) * velocidad / K;
      if (enRoja(la, lo)) {
        // Si ya está dentro de una roja, solo vale un paso que se aleje del centro de esa zona
        if (!huir || dist(la, lo) <= dist(b.lat, b.lng)) continue;
      }
      if (zona && !puedeSalir && estaDentro(b.lat, b.lng, zona) && !estaDentro(la, lo, zona)) continue;
      b.lat = la; b.lng = lo; b.h = a;
      return;
    }
  }
}

function simTick() {
  const zona = getZona();
  const prohs = getProhibidas().map(z => z.puntos);
  const enRoja = (la, lo) => prohs.some(z => estaDentro(la, lo, z));
  const sun = sinElevacion(Date.now());
  const centro = zona ? centroide(zona) : CENTER;
  const ahora = Date.now();

  for (const b of sim) {
    b.bat = Math.min(100, Math.max(0, b.bat + (sun > 0 ? sun * 0.005 : -0.00075)));
    b.temp = Math.min(39.5, Math.max(37.5, b.temp + (Math.random() - 0.5) * 0.04));

    // Cambia de actividad por tramos largos: pastar 8-30 min, caminar 1-5 min, descansar 5-20 min
    if (ahora > b.hastaCambio) {
      const x = Math.random();
      b.act = x < 0.6 ? 'Pastando' : x < 0.85 ? 'Caminando' : 'Descansando';
      const minutos = b.act === 'Pastando' ? 8 + Math.random() * 22
        : b.act === 'Caminando' ? 1 + Math.random() * 4 : 5 + Math.random() * 15;
      b.hastaCambio = ahora + minutos * 60e3;
      b.pasto = zona && b.act === 'Pastando' ? puntoCerca(b, zona, enRoja) : null;
    }

    let velocidad = b.act === 'Caminando' ? WALK * (0.5 + Math.random() * 0.6)
      : b.act === 'Pastando' ? GRAZE * (0.3 + Math.random() * 1.2) : 0;
    let quiere;
    let puedeSalir = false;
    let huir = null;

    if (b.escaping) {
      quiere = 0; velocidad = WALK; puedeSalir = true; b.act = 'Caminando';
    } else if (enRoja(b.lat, b.lng)) {
      // Dentro de una zona roja: sale hacia fuera de ella
      const z = prohs.find(z => estaDentro(b.lat, b.lng, z));
      const c = centroide(z);
      quiere = angulo(b.lat - c[0], b.lng - c[1]);
      velocidad = WALK; puedeSalir = true; huir = c;
    } else if (zona && !estaDentro(b.lat, b.lng, zona)) {
      // Fuera de la zona azul: vuelve
      quiere = angulo(centro[0] - b.lat, centro[1] - b.lng);
      velocidad = WALK;
    } else if (b.pasto) {
      quiere = angulo(b.pasto[0] - b.lat, b.pasto[1] - b.lng);
      if (Math.hypot(b.pasto[0] - b.lat, b.pasto[1] - b.lng) < 0.00003) b.pasto = puntoCerca(b, zona, enRoja);
    } else {
      quiere = b.h;
    }

    // Giros suaves: al pastar casi no cambia de rumbo, al caminar gira algo más
    const maxGiro = b.act === 'Caminando' ? 0.25 : 0.12;
    const giro = normal(quiere - b.h);
    const azar = b.act === 'Caminando' ? 0.3 : 0.5;
    b.h = normal(b.h + Math.max(-maxGiro, Math.min(maxGiro, giro)) + (Math.random() - 0.5) * azar * 0.2);

    if (velocidad > 0) paso(b, velocidad, zona, enRoja, puedeSalir, huir);
    if (b.escaping && zona && !estaDentro(b.lat, b.lng, zona)) b.escaping = false;

    guardar({ animal: b.id, ts: Date.now(), lat: b.lat, lng: b.lng, bateria: b.bat, temperatura: b.temp, actividad: b.act });
  }
}

// ---------- Series de 24 h (una barra por hora) ----------
// prohibidaMin: minutos dentro de zona roja en esa hora
// m2: m² acumulados que se han pisado desde el inicio de la ventana (celdas de 5 m)
function celda(lat, lng) {
  return Math.floor(lat / CELL_LAT) + ':' + Math.floor(lng / CELL_LNG);
}

function serie(animal) {
  const H = 24;
  const zonas = getProhibidas().map(z => z.puntos);
  const start = Date.now() - H * 3600e3;
  const rows = animal ? historyStmt.all(animal, start) : allStmt.all(start);
  const prohMin = new Array(H).fill(0);
  const celdasHora = Array.from({ length: H }, () => new Set());
  const previo = new Map();

  for (const r of rows) {
    const key = animal ?? r.animal;
    const hi = Math.min(H - 1, Math.floor((r.ts - start) / 3600e3));
    celdasHora[hi].add(celda(r.lat, r.lng));
    const p = previo.get(key);
    if (p && p.enRoja && r.ts - p.ts <= MAX_GAP_MS) {
      const pi = Math.min(H - 1, Math.floor((p.ts - start) / 3600e3));
      prohMin[pi] += (r.ts - p.ts) / 60000;
    }
    previo.set(key, { ts: r.ts, enRoja: zonas.some(z => estaDentro(r.lat, r.lng, z)) });
  }

  const union = new Set();
  return Array.from({ length: H }, (_, h) => {
    celdasHora[h].forEach(c => union.add(c));
    return { ts: start + h * 3600e3, prohibidaMin: Math.round(prohMin[h]), m2: union.size * CELDA_M2 };
  });
}

// ---------- HTTP ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function leerBody(req) {
  return new Promise((ok, ko) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ko(e); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    // Entrada de datos: el collar (o el simulador) envía una lectura
    if (p === '/api/lecturas' && req.method === 'POST') {
      const b = await leerBody(req);
      if (!Number.isFinite(b.animal) || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
        return json(res, 400, { error: 'animal, lat y lng son obligatorios' });
      }
      guardar({
        animal: b.animal,
        ts: Number.isFinite(b.ts) ? b.ts : Date.now(),
        lat: b.lat,
        lng: b.lng,
        bateria: b.bateria ?? null,
        temperatura: b.temperatura ?? null,
        actividad: b.actividad ?? null
      });
      return json(res, 201, { ok: true });
    }

    if (p === '/api/estado' && req.method === 'GET') {
      const zona = getZona();
      const prohs = getProhibidas();
      const animales = latestStmt.all().map(a => ({
        ...a,
        dentro: zona ? (estaDentro(a.lat, a.lng, zona) ? 1 : 0) : 1,
        enProhibida: prohs.some(z => estaDentro(a.lat, a.lng, z.puntos))
      }));
      return json(res, 200, { animales, zona, prohibidas: prohs });
    }

    if (p === '/api/historial' && req.method === 'GET') {
      const id = Number(url.searchParams.get('animal'));
      const horas = Number(url.searchParams.get('horas') || 24);
      return json(res, 200, historyStmt.all(id, Date.now() - horas * 3600e3));
    }

    if (p === '/api/estadisticas' && req.method === 'GET') {
      const id = Number(url.searchParams.get('animal'));
      const horas = Number(url.searchParams.get('horas') || 24);
      return json(res, 200, estadisticas(id, horas));
    }

    if (p === '/api/serie' && req.method === 'GET') {
      const a = url.searchParams.get('animal');
      return json(res, 200, serie(a ? Number(a) : null));
    }

    if (p === '/api/zona' && req.method === 'GET') return json(res, 200, { zona: getZona() });

    if (p === '/api/zona' && req.method === 'POST') {
      const b = await leerBody(req);
      if (!esPoligono(b.puntos)) return json(res, 400, { error: 'Hacen falta al menos 3 puntos válidos' });
      zonaSet.run(JSON.stringify(b.puntos));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/zona' && req.method === 'DELETE') {
      zonaDel.run();
      return json(res, 200, { ok: true });
    }

    // Zonas prohibidas (rojas): se pueden añadir varias
    if (p === '/api/prohibidas' && req.method === 'GET') return json(res, 200, { zonas: getProhibidas() });

    if (p === '/api/prohibidas' && req.method === 'POST') {
      const b = await leerBody(req);
      if (!esPoligono(b.puntos)) return json(res, 400, { error: 'Hacen falta al menos 3 puntos válidos' });
      prohAdd.run(JSON.stringify(b.puntos), Date.now());
      return json(res, 201, { ok: true });
    }

    if (p === '/api/prohibidas' && req.method === 'DELETE') {
      prohDelAll.run();
      return json(res, 200, { ok: true });
    }

    const mProh = p.match(/^\/api\/prohibidas\/(\d+)$/);
    if (mProh && req.method === 'DELETE') {
      prohDel.run(Number(mProh[1]));
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/simular-salida/') && req.method === 'POST') {
      const s = sim.find(x => x.id === Number(p.split('/').pop()));
      if (!s) return json(res, 404, { error: 'Ese animal no es simulado' });
      s.escaping = true;
      return json(res, 200, { ok: true });
    }

    // Web estática (index.html, logo, etc.)
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const base = path.join(__dirname, 'public');
    const full = path.join(base, path.normalize(rel));
    if (!full.startsWith(base)) return json(res, 403, { error: 'Prohibido' });
    fs.readFile(full, (err, data) => {
      if (err) return json(res, 404, { error: 'No encontrado' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 400, { error: 'Petición no válida' });
  }
});

server.listen(PORT, () => {
  console.log(`BISONTECH en http://localhost:${PORT}` + (SIM ? ' (simulador activo)' : ''));
});

if (SIM) {
  simTick();
  setInterval(simTick, TICK_MS);
}
