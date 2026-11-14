const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('./db');

// ---------- Configuración ----------
// Funciona tanto con carpetas (src/, public/) como con todos los archivos sueltos en la raíz.
const ROOT = fs.existsSync(path.join(__dirname, 'evento.json')) ? __dirname : path.join(__dirname, '..');
const PUBLIC_DIR = fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public') : ROOT;
const EVENTO = JSON.parse(fs.readFileSync(path.join(ROOT, 'evento.json'), 'utf8'));
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const MP_ON = EVENTO.mercadopago?.habilitado && !!MP_TOKEN;
const TRANSF_ON = !!EVENTO.transferencia?.habilitada;
const RESERVA_MP_MS = 30 * 60 * 1000; // una orden MP sin pagar reserva lugar 30 min
const RESERVA_TRANSF_MS = 3 * 60 * 60 * 1000; // transferencia sin comprobante: 3 h

if (!process.env.ADMIN_PASSWORD || !process.env.STAFF_PIN) {
  console.warn('⚠️  Usando ADMIN_PASSWORD / STAFF_PIN por defecto. Configuralos antes de publicar.');
}
if (EVENTO.mercadopago?.habilitado && !MP_TOKEN) {
  console.warn('⚠️  Mercado Pago está habilitado en evento.json pero falta MP_ACCESS_TOKEN: queda desactivado.');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

// Servir la librería del escáner desde node_modules
app.get('/vendor/html5-qrcode.min.js', (req, res) =>
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'))
);
// Solo se sirven estos archivos públicos (nunca el código del servidor ni la configuración)
const PUBLICOS = { '/': 'index.html', '/orden': 'orden.html', '/scanner': 'scanner.html', '/admin': 'admin.html', '/styles.css': 'styles.css', '/limon.svg': 'limon.svg' };
for (const [ruta, archivo] of Object.entries(PUBLICOS)) {
  const enviar = (req, res) => res.sendFile(path.join(PUBLIC_DIR, archivo));
  app.get(ruta, enviar);
  if (archivo.endsWith('.html') && ruta !== '/') app.get(`/${archivo}`, enviar);
}

// ---------- Utilidades ----------
// FECHA_SIMULADA solo sirve para probar las tandas (ej: 2026-11-28T12:00:00-03:00). No usar en producción.
const OFFSET_SIM = process.env.FECHA_SIMULADA ? Date.parse(process.env.FECHA_SIMULADA) - Date.now() : 0;
const now = () => Date.now() + OFFSET_SIM;
const nuevoId = () => crypto.randomBytes(12).toString('base64url');
const nuevoCodigo = () => 'TK-' + crypto.randomBytes(16).toString('base64url');
const limpio = (s, max = 120) => String(s ?? '').trim().slice(0, max);

// Tandas: cada una vale desde las 00:00 de "desde" hasta "hasta" a las 23:59 (o a "hastaHora"), hora Argentina.
// Además, cada tanda tiene un cupo: si se agota antes de su fecha, se abre la siguiente en el momento.
const TZ = EVENTO.zonaHoraria || '-03:00';
const TANDAS = EVENTO.tandas.map((t) => ({
  ...t,
  inicio: Date.parse(`${t.desde}T${t.desdeHora || '00:00'}:00${TZ}`),
  fin: t.hastaHora ? Date.parse(`${t.hasta}T${t.hastaHora}:00${TZ}`) - 1 : Date.parse(`${t.hasta}T23:59:59.999${TZ}`),
}));
const PROMO = EVENTO.promo || null;
const INVITACION = { id: 'invitacion', nombre: 'Invitación', precio: 0 };
const tipoPorId = (id) => (id === INVITACION.id ? INVITACION : TANDAS.find((t) => t.id === id));
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

// Condición SQL de órdenes que ocupan lugar: pagadas, o pendientes recientes (reserva temporal)
const OCUPA = `(estado = 'pagado'
  OR (estado = 'pendiente' AND metodo = 'mp' AND created_at > $1)
  OR (estado = 'pendiente' AND metodo = 'transfer' AND (comprobante IS NOT NULL OR created_at > $2)))`;
const paramsOcupa = () => [now() - RESERVA_MP_MS, now() - RESERVA_TRANSF_MS];

async function ocupadasPorTanda() {
  const rows = await db.all(`SELECT tipo, COALESCE(SUM(cantidad),0) AS n FROM orders WHERE ${OCUPA} GROUP BY tipo`, paramsOcupa());
  const m = {};
  for (const r of rows) m[r.tipo] = Number(r.n);
  return m;
}
async function promosUsadas() {
  const rows = await db.all(`SELECT COUNT(*) AS n FROM orders WHERE promo = 1 AND ${OCUPA}`, paramsOcupa());
  return Number(rows[0].n);
}

// Calcula qué se está vendiendo ahora mismo
async function estadoVenta() {
  const ocupadas = await ocupadasPorTanda();
  const t = now();
  for (let i = 0; i < TANDAS.length; i++) {
    const tanda = TANDAS[i];
    const restantes = Math.max(0, tanda.cupo - (ocupadas[tanda.id] || 0));
    const terminada = t > tanda.fin || restantes <= 0;
    if (terminada) continue;
    // La 1ra tanda abre en su fecha. Las demás abren en su fecha o antes, si la anterior se agotó.
    if (t < tanda.inicio && i === 0) return { estado: 'proxima', abre: tanda.inicio };
    const res = { estado: 'abierta', tanda, indice: i, restantes, siguiente: TANDAS[i + 1] || null };
    if (PROMO && PROMO.tanda === tanda.id && restantes >= PROMO.cantidad) {
      const quedan = PROMO.maximo - (await promosUsadas());
      if (quedan > 0) res.promo = { cantidad: PROMO.cantidad, precio: PROMO.precio, quedan };
    }
    return res;
  }
  // No queda ninguna tanda: o se vendió todo, o pasó la fecha
  return { estado: t > TANDAS[TANDAS.length - 1].fin ? 'cerrada' : 'agotada' };
}

function textoHasta(tanda) {
  return tanda.hastaHora ? `${ddmm(tanda.hasta)} a las ${parseInt(tanda.hastaHora, 10)}${tanda.hastaHora.endsWith(':00') ? '' : tanda.hastaHora.slice(2)} hs` : ddmm(tanda.hasta);
}

// Marca la orden como pagada (una sola vez) y genera las entradas.
async function marcarPagada(orderId, extra = {}) {
  const rows = await db.all(
    `UPDATE orders SET estado = 'pagado', paid_at = $2, mp_payment_id = COALESCE($3, mp_payment_id)
     WHERE id = $1 AND estado <> 'pagado' RETURNING *`,
    [orderId, now(), extra.mpPaymentId || null]
  );
  if (!rows.length) return false; // ya estaba pagada
  const o = rows[0];
  let asistentes = [];
  try { asistentes = JSON.parse(o.asistentes || '[]'); } catch {}
  for (let i = 1; i <= o.cantidad; i++) {
    // Cada entrada queda a nombre de su persona (si no hay datos, a nombre del comprador)
    const a = asistentes[i - 1];
    const nombre = a ? `${a.nombre} ${a.apellido}` : o.nombre;
    const dni = a ? a.dni : o.dni;
    await db.all(
      `INSERT INTO tickets (code, order_id, tipo, nombre, dni, n) VALUES ($1,$2,$3,$4,$5,$6)`,
      [nuevoCodigo(), o.id, o.tipo, nombre, dni, i]
    );
  }
  console.log(`✅ Orden ${o.id} pagada (${o.cantidad} x ${o.tipo}) - ${o.nombre}`);
  return true;
}

// ---------- Sesiones (cookie firmada) ----------
function firmar(valor) {
  return crypto.createHmac('sha256', SECRET).update(valor).digest('base64url');
}
function crearSesion(res, rol) {
  const exp = now() + 24 * 60 * 60 * 1000;
  const v = `${rol}.${exp}`;
  res.setHeader(
    'Set-Cookie',
    `sesion=${v}.${firmar(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${BASE_URL.startsWith('https') ? '; Secure' : ''}`
  );
}
function leerRol(req) {
  const c = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('sesion='));
  if (!c) return null;
  const [rol, exp, sig] = c.slice(7).split('.');
  if (!rol || !exp || !sig) return null;
  const esperado = firmar(`${rol}.${exp}`);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  if (Number(exp) < now()) return null;
  return rol;
}
const requiere = (...roles) => (req, res, next) => {
  const rol = leerRol(req);
  if (!rol || !roles.includes(rol)) return res.status(401).json({ error: 'No autorizado' });
  req.rol = rol;
  next();
};

const intentos = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const reg = intentos.get(ip) || { n: 0, t: now() };
  if (now() - reg.t > 10 * 60 * 1000) { reg.n = 0; reg.t = now(); }
  if (reg.n >= 10) return res.status(429).json({ error: 'Demasiados intentos, esperá unos minutos' });
  const { rol, clave } = req.body || {};
  const ok = (rol === 'admin' && clave === ADMIN_PASSWORD) || (rol === 'staff' && clave === STAFF_PIN);
  if (!ok) {
    reg.n++; intentos.set(ip, reg);
    return res.status(401).json({ error: 'Clave incorrecta' });
  }
  intentos.delete(ip);
  crearSesion(res, rol);
  res.json({ ok: true, rol });
});
app.get('/api/sesion', (req, res) => res.json({ rol: leerRol(req) }));
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sesion=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- Público ----------
app.get('/api/evento', async (req, res) => {
  const out = {
    nombre: EVENTO.nombre, fecha: EVENTO.fecha, lugar: EVENTO.lugar, descripcion: EVENTO.descripcion,
    moneda: EVENTO.moneda, maxPorCompra: EVENTO.maxPorCompra,
    metodos: { mp: MP_ON, transfer: TRANSF_ON },
  };
  const v = await estadoVenta();
  out.estado = v.estado;
  if (v.estado === 'proxima') out.abre = v.abre;
  if (v.estado === 'abierta') {
    // Solo se manda la tanda vigente: nunca el precio de las próximas.
    const t = v.tanda;
    out.tanda = { nombre: t.nombre, precio: t.precio, hastaTexto: textoHasta(t), haySiguiente: !!v.siguiente };
    out.maxCompra = Math.min(EVENTO.maxPorCompra || 6, v.restantes);
    if (EVENTO.mostrarVendidasEn === t.id) {
      const r = await db.all(`SELECT COUNT(*) AS n FROM tickets WHERE tipo = $1`, [t.id]);
      out.vendidas = Number(r[0].n);
    }
    if (EVENTO.mostrarQuedanEn === t.id) out.quedan = v.restantes;
    if (v.promo) out.promo = v.promo;
  }
  res.json(out);
});

app.post('/api/ordenes', async (req, res) => {
  try {
    const b = req.body || {};
    const email = limpio(b.email).toLowerCase();
    const telefono = limpio(b.telefono, 30);
    const metodo = b.metodo;
    const lista = Array.isArray(b.asistentes) ? b.asistentes : [];
    const cantidad = lista.length;
    if (!(cantidad >= 1 && cantidad <= (EVENTO.maxPorCompra || 6))) return res.status(400).json({ error: 'Cantidad inválida' });

    // Datos de cada persona: una entrada = un nombre, apellido y DNI
    const asistentes = [];
    const dnis = new Set();
    for (let i = 0; i < lista.length; i++) {
      const a = lista[i] || {};
      const nombre = limpio(a.nombre, 60), apellido = limpio(a.apellido, 60), dni = limpio(a.dni, 20).replace(/\D/g, '');
      const quien = cantidad > 1 ? ` (entrada ${i + 1})` : '';
      if (nombre.length < 2) return res.status(400).json({ error: `Falta el nombre${quien}` });
      if (apellido.length < 2) return res.status(400).json({ error: `Falta el apellido${quien}` });
      if (dni.length < 7 || dni.length > 9) return res.status(400).json({ error: `DNI inválido${quien}` });
      if (dnis.has(dni)) return res.status(400).json({ error: `El DNI ${dni} está repetido: cada entrada tiene que ser de una persona distinta` });
      dnis.add(dni);
      asistentes.push({ nombre, apellido, dni });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });
    if (!((metodo === 'mp' && MP_ON) || (metodo === 'transfer' && TRANSF_ON))) return res.status(400).json({ error: 'Método de pago no disponible' });

    // El precio lo decide el servidor según la tanda vigente, nunca el navegador
    const v = await estadoVenta();
    if (v.estado !== 'abierta') return res.status(400).json({ error: 'La venta no está abierta en este momento' });
    const tipo = v.tanda;
    if (cantidad > v.restantes) return res.status(409).json({ error: `Solo quedan ${v.restantes} entradas a este precio` });
    const esPromo = !!(v.promo && cantidad === v.promo.cantidad);
    const total = esPromo ? v.promo.precio : tipo.precio * cantidad;

    const id = nuevoId();
    const comprador = asistentes[0];
    await db.all(
      `INSERT INTO orders (id, created_at, nombre, email, dni, telefono, tipo, cantidad, total, metodo, estado, asistentes, promo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendiente',$11,$12)`,
      [id, now(), `${comprador.nombre} ${comprador.apellido}`, email, comprador.dni, telefono, tipo.id, cantidad, total, metodo, JSON.stringify(asistentes), esPromo ? 1 : 0]
    );
    const nombre = `${comprador.nombre} ${comprador.apellido}`;

    if (metodo === 'transfer') return res.json({ id, url: `/orden?id=${id}` });

    // Mercado Pago Checkout Pro
    const pref = {
      items: [esPromo
        ? { id: 'promo', title: `${EVENTO.nombre} - Promo ${cantidad} entradas (${tipo.nombre})`, quantity: 1, unit_price: total, currency_id: EVENTO.moneda || 'ARS' }
        : { id: tipo.id, title: `${EVENTO.nombre} - Entrada (${tipo.nombre})`, quantity: cantidad, unit_price: tipo.precio, currency_id: EVENTO.moneda || 'ARS' }],
      payer: { name: nombre, email },
      external_reference: id,
      back_urls: {
        success: `${BASE_URL}/orden?id=${id}`,
        pending: `${BASE_URL}/orden?id=${id}`,
        failure: `${BASE_URL}/orden?id=${id}`,
      },
      notification_url: `${BASE_URL}/webhook/mp`,
      statement_descriptor: 'ENTRADAS',
      expires: true,
      expiration_date_to: new Date(now() + RESERVA_MP_MS).toISOString(),
    };
    if (BASE_URL.startsWith('https')) pref.auto_return = 'approved';
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pref),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Error MP:', data);
      await db.all(`UPDATE orders SET estado = 'vencido' WHERE id = $1`, [id]);
      return res.status(502).json({ error: 'No se pudo iniciar el pago con Mercado Pago' });
    }
    res.json({ id, url: data.init_point });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Consulta a MP los pagos de una orden (por si el webhook no llegó)
const ultimaConsulta = new Map();
async function verificarMP(order, paymentId) {
  if (!MP_ON) return;
  const k = order.id;
  if (!paymentId && now() - (ultimaConsulta.get(k) || 0) < 8000) return;
  ultimaConsulta.set(k, now());
  try {
    let pagos = [];
    if (paymentId) {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
      if (r.ok) pagos = [await r.json()];
    } else {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(order.id)}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
      if (r.ok) pagos = (await r.json()).results || [];
    }
    for (const p of pagos) await procesarPagoMP(p);
  } catch (e) {
    console.error('verificarMP', e.message);
  }
}

async function procesarPagoMP(p) {
  if (!p || p.status !== 'approved') return;
  const rows = await db.all(`SELECT * FROM orders WHERE id = $1`, [p.external_reference]);
  const o = rows[0];
  if (!o) return;
  if (Number(p.transaction_amount) + 0.01 < Number(o.total)) {
    console.warn(`Monto pagado menor al total en orden ${o.id}`);
    return;
  }
  await marcarPagada(o.id, { mpPaymentId: String(p.id) });
}

app.post('/webhook/mp', async (req, res) => {
  res.sendStatus(200); // MP necesita respuesta rápida
  try {
    const tipo = req.query.type || req.query.topic || req.body?.type || req.body?.topic;
    const id = req.query['data.id'] || req.body?.data?.id || req.query.id;
    if (tipo !== 'payment' || !id || !MP_ON) return;
    // Siempre se vuelve a consultar el pago a MP, así no se puede falsificar el aviso.
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
    if (r.ok) await procesarPagoMP(await r.json());
  } catch (e) {
    console.error('webhook', e.message);
  }
});

async function ordenPublica(o) {
  const out = {
    id: o.id, nombre: o.nombre, email: o.email, tipo: tipoPorId(o.tipo)?.nombre || o.tipo,
    cantidad: o.cantidad, total: o.total, metodo: o.metodo, estado: o.estado, promo: Number(o.promo) === 1,
    tieneComprobante: !!o.comprobante, evento: { nombre: EVENTO.nombre, fecha: EVENTO.fecha, lugar: EVENTO.lugar },
    moneda: EVENTO.moneda,
  };
  if (o.metodo === 'transfer' && o.estado === 'pendiente') out.transferencia = EVENTO.transferencia;
  if (o.estado === 'pagado') {
    const ts = await db.all(`SELECT code, n, used_at, nombre, dni FROM tickets WHERE order_id = $1 ORDER BY n`, [o.id]);
    out.tickets = [];
    for (const t of ts) {
      out.tickets.push({ n: t.n, code: t.code, nombre: t.nombre, dni: t.dni, usado: !!t.used_at, qr: await QRCode.toDataURL(t.code, { width: 480, margin: 2, errorCorrectionLevel: 'M' }) });
    }
  }
  return out;
}

app.get('/api/ordenes/:id', async (req, res) => {
  let rows = await db.all(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Orden no encontrada' });
  if (rows[0].metodo === 'mp' && rows[0].estado !== 'pagado') {
    await verificarMP(rows[0], req.query.payment_id);
    rows = await db.all(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
  }
  res.json(await ordenPublica(rows[0]));
});

app.post('/api/ordenes/:id/comprobante', async (req, res) => {
  const { imagen, nota } = req.body || {};
  if (!imagen || !/^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,/.test(imagen)) return res.status(400).json({ error: 'Subí una imagen o PDF del comprobante' });
  if (imagen.length > 7_000_000) return res.status(400).json({ error: 'El archivo es muy grande (máx. ~5 MB)' });
  const rows = await db.all(
    `UPDATE orders SET comprobante = $2, nota_pago = $3 WHERE id = $1 AND metodo = 'transfer' AND estado = 'pendiente' RETURNING id`,
    [req.params.id, imagen, limpio(nota, 200)]
  );
  if (!rows.length) return res.status(400).json({ error: 'Esta orden no acepta comprobantes' });
  res.json({ ok: true });
});

// ---------- Escáner (staff o admin) ----------
app.post('/api/scan', requiere('staff', 'admin'), async (req, res) => {
  let code = limpio(req.body?.code, 200);
  const m = code.match(/TK-[A-Za-z0-9_-]+/);
  if (m) code = m[0];
  const usados = await db.all(
    `UPDATE tickets SET used_at = $2, used_by = $3 WHERE code = $1 AND used_at IS NULL RETURNING *`,
    [code, now(), req.rol]
  );
  if (usados.length) {
    const t = usados[0];
    const o = (await db.all(`SELECT cantidad FROM orders WHERE id = $1`, [t.order_id]))[0];
    return res.json({ resultado: 'valido', nombre: t.nombre, dni: t.dni, tipo: tipoPorId(t.tipo)?.nombre || t.tipo, n: t.n, de: o?.cantidad });
  }
  const ex = await db.all(`SELECT * FROM tickets WHERE code = $1`, [code]);
  if (ex.length) {
    const t = ex[0];
    return res.json({ resultado: 'usado', nombre: t.nombre, dni: t.dni, tipo: tipoPorId(t.tipo)?.nombre || t.tipo, usadoEn: Number(t.used_at) });
  }
  res.json({ resultado: 'invalido' });
});

app.get('/api/scan/stats', requiere('staff', 'admin'), async (req, res) => {
  const r = await db.all(`SELECT COUNT(*) AS total, COUNT(used_at) AS adentro FROM tickets`);
  res.json({ total: Number(r[0].total), adentro: Number(r[0].adentro) });
});

// ---------- Admin ----------
app.get('/api/admin/resumen', requiere('admin'), async (req, res) => {
  const porTipo = [];
  const v = await estadoVenta();
  for (const t of [...TANDAS, INVITACION]) {
    const r = await db.all(`SELECT COUNT(*) AS vendidas, COUNT(used_at) AS ingresaron FROM tickets WHERE tipo = $1`, [t.id]);
    porTipo.push({ id: t.id, nombre: t.nombre, precio: t.precio, cupo: t.cupo || null, desde: t.desde, hasta: t.hasta, hastaTexto: t.desde ? textoHasta(t) : '', actual: v.tanda?.id === t.id, vendidas: Number(r[0].vendidas), ingresaron: Number(r[0].ingresaron) });
  }
  let promo = null;
  if (PROMO) {
    const r = await db.all(`SELECT COUNT(*) AS n FROM orders WHERE promo = 1 AND estado = 'pagado'`);
    promo = { usadas: Number(r[0].n), maximo: PROMO.maximo, cantidad: PROMO.cantidad, precio: PROMO.precio, tanda: tipoPorId(PROMO.tanda)?.nombre };
  }
  const tot = await db.all(`SELECT COUNT(*) AS vendidas, COUNT(used_at) AS ingresaron FROM tickets`);
  const rec = await db.all(`SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE estado = 'pagado'`);
  const pend = await db.all(`SELECT COUNT(*) AS n FROM orders WHERE estado = 'pendiente' AND metodo = 'transfer' AND comprobante IS NOT NULL`);
  res.json({
    porTipo, promo, cupoTotal: TANDAS.reduce((s, t) => s + (t.cupo || 0), 0) || null, vendidas: Number(tot[0].vendidas), ingresaron: Number(tot[0].ingresaron),
    recaudado: Number(rec[0].s), transferenciasARevisar: Number(pend[0].n), moneda: EVENTO.moneda,
  });
});

app.get('/api/admin/ordenes', requiere('admin'), async (req, res) => {
  const filtro = req.query.filtro || 'revisar';
  const q = limpio(req.query.q, 60).toLowerCase();
  let where = '1=1';
  if (filtro === 'revisar') where = `estado = 'pendiente' AND metodo = 'transfer' AND comprobante IS NOT NULL`;
  else if (filtro === 'pagadas') where = `estado = 'pagado'`;
  else if (filtro === 'pendientes') where = `estado = 'pendiente'`;
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (LOWER(nombre) LIKE $1 OR LOWER(email) LIKE $1 OR dni LIKE $1 OR id LIKE $1 OR LOWER(COALESCE(asistentes,'')) LIKE $1)`;
  }
  const rows = await db.all(
    `SELECT id, created_at, nombre, email, dni, telefono, tipo, cantidad, total, metodo, estado, nota_pago, paid_at, asistentes, promo,
       CASE WHEN comprobante IS NULL THEN 0 ELSE 1 END AS tiene_comprobante
     FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT 300`,
    params
  );
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  res.json(rows.map((r) => ({ ...r, asistentes: parse(r.asistentes), promo: Number(r.promo) === 1, created_at: Number(r.created_at), paid_at: r.paid_at ? Number(r.paid_at) : null, tipoNombre: tipoPorId(r.tipo)?.nombre || r.tipo })));
});

app.get('/api/admin/ordenes/:id/comprobante', requiere('admin'), async (req, res) => {
  const rows = await db.all(`SELECT comprobante FROM orders WHERE id = $1`, [req.params.id]);
  const c = rows[0]?.comprobante;
  if (!c) return res.sendStatus(404);
  const [meta, b64] = c.split(',');
  res.type(meta.slice(5, meta.indexOf(';'))).send(Buffer.from(b64, 'base64'));
});

app.post('/api/admin/ordenes/:id/aprobar', requiere('admin'), async (req, res) => {
  const ok = await marcarPagada(req.params.id);
  res.json({ ok });
});

app.post('/api/admin/ordenes/:id/rechazar', requiere('admin'), async (req, res) => {
  const rows = await db.all(`UPDATE orders SET estado = 'rechazado' WHERE id = $1 AND estado = 'pendiente' RETURNING id`, [req.params.id]);
  res.json({ ok: rows.length > 0 });
});

// Invitaciones / cortesías: entradas sin pago
app.post('/api/admin/cortesia', requiere('admin'), async (req, res) => {
  const b = req.body || {};
  const tipo = INVITACION;
  const cantidad = parseInt(b.cantidad, 10) || 1;
  const nombre = limpio(b.nombre);
  if (nombre.length < 2 || cantidad < 1 || cantidad > 50) return res.status(400).json({ error: 'Datos inválidos' });
  const id = nuevoId();
  await db.all(
    `INSERT INTO orders (id, created_at, nombre, email, dni, telefono, tipo, cantidad, total, metodo, estado)
     VALUES ($1,$2,$3,$4,$5,'',$6,$7,0,'cortesia','pendiente')`,
    [id, now(), nombre, limpio(b.email) || '-', limpio(b.dni, 20).replace(/\D/g, '') || '-', tipo.id, cantidad]
  );
  await marcarPagada(id);
  res.json({ id, url: `/orden?id=${id}` });
});

app.get('/api/admin/export.csv', requiere('admin'), async (req, res) => {
  const rows = await db.all(
    `SELECT t.code, t.nombre, t.dni, t.tipo, t.n, t.used_at, o.email, o.telefono, o.metodo, o.id AS orden
     FROM tickets t JOIN orders o ON o.id = t.order_id ORDER BY t.nombre`
  );
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lineas = ['codigo,nombre,dni,tipo,numero,ingreso,email,telefono,metodo,orden'];
  for (const r of rows) {
    lineas.push([r.code, r.nombre, r.dni, tipoPorId(r.tipo)?.nombre || r.tipo, r.n, r.used_at ? new Date(Number(r.used_at)).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '', r.email, r.telefono, r.metodo, r.orden].map(esc).join(','));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="entradas.csv"');
  res.type('text/csv; charset=utf-8').send('﻿' + lineas.join('\n'));
});

// ---------- Arranque ----------
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`🎉 ${EVENTO.nombre} corriendo en ${BASE_URL} (base de datos: ${db.kind()})`);
    console.log(`   Mercado Pago: ${MP_ON ? 'activo' : 'inactivo'} · Transferencia: ${TRANSF_ON ? 'activa' : 'inactiva'}`);
  });
});
