require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
  max: 5,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user'))
    );

    CREATE TABLE IF NOT EXISTS slots (
      id SERIAL PRIMARY KEY,
      slot_no TEXT UNIQUE NOT NULL,
      vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('car','bike'))
    );

    -- Cars and bikes keep separate records
    CREATE TABLE IF NOT EXISTS car_records (
      id SERIAL PRIMARY KEY,
      number_plate TEXT NOT NULL,
      model TEXT NOT NULL,
      slot_id INT NOT NULL REFERENCES slots(id),
      entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
      exit_time TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('parked','unparked')),
      added_by TEXT
    );
    CREATE TABLE IF NOT EXISTS bike_records (
      id SERIAL PRIMARY KEY,
      number_plate TEXT NOT NULL,
      model TEXT NOT NULL,
      slot_id INT NOT NULL REFERENCES slots(id),
      entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
      exit_time TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('parked','unparked')),
      added_by TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      number_plate TEXT NOT NULL,
      vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('car','bike')),
      slot_id INT NOT NULL REFERENCES slots(id),
      booked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','cancelled')),
      booked_by TEXT
    );

    -- A plate can only be parked once at a time; a slot can only hold one active booking
    CREATE UNIQUE INDEX IF NOT EXISTS car_one_parked  ON car_records(number_plate)  WHERE status = 'parked';
    CREATE UNIQUE INDEX IF NOT EXISTS bike_one_parked ON bike_records(number_plate) WHERE status = 'parked';
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot ON bookings(slot_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_plate ON bookings(number_plate) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS car_plate_idx  ON car_records(number_plate);
    CREATE INDEX IF NOT EXISTS bike_plate_idx ON bike_records(number_plate);
  `);

  const cars = parseInt(process.env.CAR_SLOTS || '20', 10);
  const bikes = parseInt(process.env.BIKE_SLOTS || '30', 10);
  await pool.query(
    `INSERT INTO slots (slot_no, vehicle_type)
     SELECT 'C' || g, 'car' FROM generate_series(1, $1::int) g
     ON CONFLICT (slot_no) DO NOTHING`, [cars]);
  await pool.query(
    `INSERT INTO slots (slot_no, vehicle_type)
     SELECT 'B' || g, 'bike' FROM generate_series(1, $1::int) g
     ON CONFLICT (slot_no) DO NOTHING`, [bikes]);

  const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123', 10);
  const userHash = await bcrypt.hash(process.env.USER_PASSWORD || 'User@123', 10);
  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin')
     ON CONFLICT (username) DO NOTHING`, [adminHash]);
  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ('user', $1, 'user')
     ON CONFLICT (username) DO NOTHING`, [userHash]);
}

module.exports = { pool, init };
