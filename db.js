// Capa de base de datos: usa Postgres si existe DATABASE_URL (producción),
// si no, un archivo SQLite local (para probar en tu compu).
const path = require('path');

let impl;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  impl = {
    kind: 'postgres',
    async all(sql, params = []) {
      const r = await pool.query(sql, params);
      return r.rows;
    },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_FILE || path.join(__dirname, '..', 'data.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  impl = {
    kind: 'sqlite',
    async all(sql, params = []) {
      // Convierte $1, $2... a ?1, ?2...
      const s = sql.replace(/\$(\d+)/g, '?$1');
      return db.prepare(s).all(...params);
    },
  };
}

async function init() {
  await impl.all(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL,
    dni TEXT NOT NULL,
    telefono TEXT,
    tipo TEXT NOT NULL,
    cantidad INTEGER NOT NULL,
    total INTEGER NOT NULL,
    metodo TEXT NOT NULL,
    estado TEXT NOT NULL,
    mp_payment_id TEXT,
    comprobante TEXT,
    nota_pago TEXT,
    paid_at BIGINT
  )`);
  await impl.all(`CREATE TABLE IF NOT EXISTS tickets (
    code TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    nombre TEXT NOT NULL,
    dni TEXT NOT NULL,
    n INTEGER NOT NULL,
    used_at BIGINT,
    used_by TEXT
  )`);
  await impl.all(`CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id)`);
}

module.exports = { all: (s, p) => impl.all(s, p), init, kind: () => impl.kind };
