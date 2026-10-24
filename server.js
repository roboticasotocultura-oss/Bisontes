// Servidor de control de bisontes.
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

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(__dirname, 'bisontes.db'));
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

// ---------- Geografía ----------
function getZona() {
  const row = zonaGet.get();
  return row ? JSON.parse(row.puntos) : null;
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

// ---------- Guardar y estadísticas ----------
function guardar(l) {
  const zona = getZona();
  const dentro = zona ? (estaDentro(l.lat, l.lng, zona) ? 1 : 0) : 1;
  insertStmt.run(l.animal, l.ts, l.lat, l.lng, l.bateria, l.temperatura, l.actividad, dentro);
}

function estadisticas(id, horas) {
  const rows = historyStmt.all(id, Date.now() - horas * 3600e3);
  let km = 0, minDentro = 0, minFuera = 0;
  const actividad = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.actividad) actividad[r.actividad] = (actividad[r.actividad] || 0) + 1;
    if (i === 0) continue;
    const p = rows[i - 1];
    const dtMin = Math.min(r.ts - p.ts, 10 * 60e3) / 60000; // tope de 10 min entre lecturas
    km += distanciaM(p, r) / 1000;
    if (p.dentro) minDentro += dtMin; else minFuera += dtMin;
  }
  const bats = rows.map(r => r.bateria).filter(v => v != null);
  const temps = rows.map(r => r.temperatura).filter(v => v != null);
  return {
    lecturas: rows.length,
    distanciaKm: +km.toFixed(2),
    minutosDentro: Math.round(minDentro),
    minutosFuera: Math.round(minFuera),
    bateriaMin: bats.length ? Math.min(...bats) : null,
    bateriaMax: bats.length ? Math.max(...bats) : null,
    temperaturaMedia: temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null,
    actividad
  };
}

// ---------- Simulador ----------
const sim = [1, 2, 3, 4, 5].map(id => ({
  id,
  lat: CENTER[0] + (Math.random() - 0.5) * 0.002,
  lng: CENTER[1] + (Math.random() - 0.5) * 0.003,
  bat: 40 + Math.random() * 50,
  temp: 38.5,
  act: 'Pastando',
  escaping: false
}));

function sunFactor(h) {
  const s = Math.sin(Math.PI * (h - 6) / 14);
  return s > 0 ? s : 0;
}

function realHour() {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

function simTick() {
  const zona = getZona();
  const sun = sunFactor(realHour());
  const target = zona ? centroide(zona) : null;

  for (const b of sim) {
    b.bat = Math.min(100, Math.max(0, b.bat + (sun > 0.05 ? sun * 0.005 : -0.00075)));
    b.temp = Math.min(39.5, Math.max(37.5, b.temp + (Math.random() - 0.5) * 0.04));
    if (Math.random() < 0.02) b.act = ['Pastando', 'Caminando', 'Descansando'][Math.floor(Math.random() * 3)];

    if (!zona) {
      // Sin zona: deambulan despacio alrededor de su pasto
      b.lat += (Math.random() - 0.5) * 0.00005 + (CENTER[0] - b.lat) * 0.01;
      b.lng += (Math.random() - 0.5) * 0.00006 + (CENTER[1] - b.lng) * 0.01;
    } else if (b.escaping) {
      // Salida lenta hacia el este hasta cruzar el borde
      b.lng += 0.00003;
      if (!estaDentro(b.lat, b.lng, zona)) b.escaping = false;
    } else if (estaDentro(b.lat, b.lng, zona)) {
      // Paseo lento, solo se acepta el paso si sigue dentro
      const nla = b.lat + (Math.random() - 0.5) * 0.00005;
      const nln = b.lng + (Math.random() - 0.5) * 0.00006;
      if (estaDentro(nla, nln, zona)) { b.lat = nla; b.lng = nln; }
    } else {
      // Fuera: vuelve despacio hacia el centro de la zona
      const dla = target[0] - b.lat, dln = target[1] - b.lng;
      const d = Math.hypot(dla, dln) || 1;
      const step = 0.00004;
      b.lat += dla / d * Math.min(step, d);
      b.lng += dln / d * Math.min(step, d);
    }

    guardar({ animal: b.id, ts: Date.now(), lat: b.lat, lng: b.lng, bateria: b.bat, temperatura: b.temp, actividad: b.act });
  }
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

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
      return json(res, 200, { animales: latestStmt.all(), zona: getZona() });
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

    if (p === '/api/zona' && req.method === 'GET') return json(res, 200, { zona: getZona() });

    if (p === '/api/zona' && req.method === 'POST') {
      const b = await leerBody(req);
      if (!Array.isArray(b.puntos) || b.puntos.length < 3) return json(res, 400, { error: 'Hacen falta al menos 3 puntos' });
      zonaSet.run(JSON.stringify(b.puntos));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/zona' && req.method === 'DELETE') {
      zonaDel.run();
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/simular-salida/') && req.method === 'POST') {
      const s = sim.find(x => x.id === Number(p.split('/').pop()));
      if (!s) return json(res, 404, { error: 'Ese animal no es simulado' });
      s.escaping = true;
      return json(res, 200, { ok: true });
    }

    // Web estática
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const base = path.join(__dirname, 'public');
    const full = path.join(base, path.normalize(rel));
    if (!full.startsWith(base)) return json(res, 403, { error: 'Prohibido' });
    fs.readFile(full, (err, data) => {
      if (err) return json(res, 404, { error: 'No encontrado' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 400, { error: 'Petición no válida' });
  }
});

server.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}` + (SIM ? ' (simulador activo)' : ''));
});

if (SIM) {
  simTick();
  setInterval(simTick, TICK_MS);
}
