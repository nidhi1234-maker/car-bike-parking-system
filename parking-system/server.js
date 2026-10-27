require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, init } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const TABLE = { car: 'car_records', bike: 'bike_records' }; // whitelist, never built from raw input

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

/* ---------- auth ---------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Your session has ended. Please log in again.' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can do this.' });
  next();
}

app.post('/api/login', wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE username = $1 AND role = $2',
    [String(username || '').trim().toLowerCase(), role === 'admin' ? 'admin' : 'user']
  );
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const token = jwt.sign({ id: u.id, username: u.username, role: u.role }, SECRET, { expiresIn: '8h' });
  res.json({ token, user: { username: u.username, role: u.role } });
}));

/* ---------- stats ---------- */
app.get('/api/stats', auth, wrap(async (req, res) => {
  const [slots, parked, booked] = await Promise.all([
    pool.query(`SELECT vehicle_type, count(*)::int AS n FROM slots GROUP BY 1`),
    pool.query(`SELECT 'car' AS vehicle_type, count(*)::int AS n FROM car_records WHERE status='parked'
                UNION ALL
                SELECT 'bike', count(*)::int FROM bike_records WHERE status='parked'`),
    pool.query(`SELECT vehicle_type, count(*)::int AS n FROM bookings WHERE status='active' GROUP BY 1`),
  ]);
  const pick = (r, t) => (r.rows.find((x) => x.vehicle_type === t) || { n: 0 }).n;
  const out = {};
  for (const t of ['car', 'bike']) {
    const total = pick(slots, t), p = pick(parked, t), b = pick(booked, t);
    out[t] = { total, parked: p, booked: b, available: total - p - b };
  }
  res.json(out);
}));

/* ---------- park a vehicle (admin) ---------- */
app.post('/api/park', auth, adminOnly, wrap(async (req, res) => {
  const type = req.body.type;
  const plate = normPlate(req.body.plate);
  const model = String(req.body.model || '').trim();
  if (!TABLE[type]) return res.status(400).json({ error: 'Choose car or bike.' });
  if (plate.length < 4) return res.status(400).json({ error: 'Enter a valid number plate.' });
  if (!model) return res.status(400).json({ error: `Enter the ${type} model.` });
  const table = TABLE[type];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query(
      `SELECT 1 FROM car_records WHERE number_plate=$1 AND status='parked'
       UNION ALL SELECT 1 FROM bike_records WHERE number_plate=$1 AND status='parked'`, [plate]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${plate} is already parked.` });
    }

    // Use the slot this plate booked, otherwise the first free slot
    let slotId, bookingId = null;
    const bk = await client.query(
      `SELECT id, slot_id FROM bookings
       WHERE number_plate=$1 AND vehicle_type=$2 AND status='active' FOR UPDATE`, [plate, type]);
    if (bk.rowCount) {
      slotId = bk.rows[0].slot_id;
      bookingId = bk.rows[0].id;
    } else {
      const free = await client.query(
        `SELECT s.id FROM slots s
         WHERE s.vehicle_type=$1
           AND NOT EXISTS (SELECT 1 FROM ${table} r WHERE r.slot_id=s.id AND r.status='parked')
           AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id=s.id AND b.status='active')
         ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, [type]);
      if (!free.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `No free ${type} slots right now.` });
      }
      slotId = free.rows[0].id;
    }

    const ins = await client.query(
      `INSERT INTO ${table} (number_plate, model, slot_id, added_by)
       VALUES ($1,$2,$3,$4) RETURNING id, entry_time`,
      [plate, model, slotId, req.user.username]);
    if (bookingId) await client.query(`UPDATE bookings SET status='used' WHERE id=$1`, [bookingId]);
    const slot = await client.query('SELECT slot_no FROM slots WHERE id=$1', [slotId]);

    await client.query('COMMIT');
    res.json({ id: ins.rows[0].id, entry_time: ins.rows[0].entry_time, slot_no: slot.rows[0].slot_no, plate, type });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'That vehicle or slot was just taken. Try again.' });
    throw e;
  } finally {
    client.release();
  }
}));

/* ---------- unpark (admin) ---------- */
app.post('/api/unpark/:type/:id', auth, adminOnly, wrap(async (req, res) => {
  const table = TABLE[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown vehicle type.' });
  const { rows } = await pool.query(
    `UPDATE ${table} SET status='unparked', exit_time=now()
     WHERE id=$1 AND status='parked' RETURNING number_plate, exit_time`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'This vehicle is not parked.' });
  res.json(rows[0]);
}));

/* ---------- currently parked ---------- */
app.get('/api/current', auth, wrap(async (req, res) => {
  const type = req.query.type;
  if (!TABLE[type]) return res.status(400).json({ error: 'Choose car or bike.' });
  const { rows } = await pool.query(
    `SELECT r.id, r.number_plate, r.model, r.entry_time, s.slot_no
     FROM ${TABLE[type]} r JOIN slots s ON s.id = r.slot_id
     WHERE r.status='parked' ORDER BY r.entry_time DESC`);
  res.json(rows);
}));

/* ---------- search history by plate ---------- */
app.get('/api/search', auth, wrap(async (req, res) => {
  const plate = normPlate(req.query.plate);
  if (plate.length < 2) return res.status(400).json({ error: 'Enter at least 2 characters of the number plate.' });
  const like = `%${plate}%`;
  const history = await pool.query(
    `SELECT * FROM (
       SELECT 'car' AS vehicle_type, r.id, r.number_plate, r.model, s.slot_no, r.entry_time, r.exit_time, r.status
       FROM car_records r JOIN slots s ON s.id=r.slot_id WHERE r.number_plate LIKE $1
       UNION ALL
       SELECT 'bike', r.id, r.number_plate, r.model, s.slot_no, r.entry_time, r.exit_time, r.status
       FROM bike_records r JOIN slots s ON s.id=r.slot_id WHERE r.number_plate LIKE $1
     ) h ORDER BY entry_time DESC LIMIT 200`, [like]);
  const bookings = await pool.query(
    `SELECT b.id, b.number_plate, b.vehicle_type, s.slot_no, b.booked_at, b.status
     FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.number_plate LIKE $1
     ORDER BY b.booked_at DESC LIMIT 100`, [like]);
  res.json({ history: history.rows, bookings: bookings.rows });
}));

/* ---------- slots ---------- */
app.get('/api/slots', auth, wrap(async (req, res) => {
  const type = req.query.type;
  if (!TABLE[type]) return res.status(400).json({ error: 'Choose car or bike.' });
  const { rows } = await pool.query(
    `SELECT s.id, s.slot_no,
            r.number_plate AS parked_plate, b.number_plate AS booked_plate,
            CASE WHEN r.id IS NOT NULL THEN 'occupied'
                 WHEN b.id IS NOT NULL THEN 'booked'
                 ELSE 'free' END AS state
     FROM slots s
     LEFT JOIN ${TABLE[type]} r ON r.slot_id=s.id AND r.status='parked'
     LEFT JOIN bookings b ON b.slot_id=s.id AND b.status='active'
     WHERE s.vehicle_type=$1 ORDER BY s.id`, [type]);
  res.json(rows);
}));

/* ---------- bookings (admin and user) ---------- */
app.get('/api/bookings', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.number_plate, b.vehicle_type, s.slot_no, b.booked_at, b.booked_by
     FROM bookings b JOIN slots s ON s.id=b.slot_id
     WHERE b.status='active' ORDER BY b.booked_at DESC`);
  res.json(rows);
}));

app.post('/api/book', auth, wrap(async (req, res) => {
  const type = req.body.type;
  const plate = normPlate(req.body.plate);
  const wanted = req.body.slot_id ? parseInt(req.body.slot_id, 10) : null;
  if (!TABLE[type]) return res.status(400).json({ error: 'Choose car or bike.' });
  if (plate.length < 4) return res.status(400).json({ error: 'Enter a valid number plate.' });
  const table = TABLE[type];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT 1 FROM bookings WHERE number_plate=$1 AND status='active'
       UNION ALL SELECT 1 FROM car_records WHERE number_plate=$1 AND status='parked'
       UNION ALL SELECT 1 FROM bike_records WHERE number_plate=$1 AND status='parked'`, [plate]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${plate} already has a booking or is parked.` });
    }

    const freeSql = `
      SELECT s.id, s.slot_no FROM slots s
      WHERE s.vehicle_type=$1 ${wanted ? 'AND s.id=$2' : ''}
        AND NOT EXISTS (SELECT 1 FROM ${table} r WHERE r.slot_id=s.id AND r.status='parked')
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id=s.id AND b.status='active')
      ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`;
    const free = await client.query(freeSql, wanted ? [type, wanted] : [type]);
    if (!free.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: wanted ? 'That slot is not free anymore.' : `No free ${type} slots right now.` });
    }
    const slot = free.rows[0];
    const ins = await client.query(
      `INSERT INTO bookings (number_plate, vehicle_type, slot_id, booked_by)
       VALUES ($1,$2,$3,$4) RETURNING id, booked_at`, [plate, type, slot.id, req.user.username]);
    await client.query('COMMIT');
    res.json({ id: ins.rows[0].id, booked_at: ins.rows[0].booked_at, slot_no: slot.slot_no, plate, type });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'That slot or plate was just booked. Try again.' });
    throw e;
  } finally {
    client.release();
  }
}));

app.post('/api/bookings/:id/cancel', auth, adminOnly, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE bookings SET status='cancelled' WHERE id=$1 AND status='active'`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ ok: true });
}));

/* ---------- accounts (admin changes usernames / passwords) ---------- */
app.get('/api/accounts', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role FROM users ORDER BY role, id');
  res.json(rows);
}));

app.put('/api/accounts/:id', auth, adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const username = String(req.body.username || '').trim().toLowerCase() || null;
  const password = req.body.password ? String(req.body.password) : null;
  if (!username && !password) return res.status(400).json({ error: 'Enter a new username or a new password.' });
  if (username && !/^[a-z0-9_.-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3 to 30 characters: letters, numbers, dot, dash or underscore.' });
  }
  if (password && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const found = await pool.query('SELECT id FROM users WHERE id=$1', [id]);
  if (!found.rowCount) return res.status(404).json({ error: 'Account not found.' });

  try {
    if (username) await pool.query('UPDATE users SET username=$1 WHERE id=$2', [username, id]);
    if (password) await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 10), id]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    throw e;
  }
  res.json({ ok: true, relogin: id === req.user.id });
}));

/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Parking system running at http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Could not set up the database:', err.message);
    process.exit(1);
  });
