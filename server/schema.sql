-- Studio Noor booking database schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS bookings (
  id                 TEXT PRIMARY KEY,
  class_date         TEXT NOT NULL,               -- 'YYYY-MM-DD', the specific occurrence being booked
  session_time       TEXT NOT NULL,                -- 'HH:MM', 24-hour, Asia/Dubai wall-clock time
  class_name         TEXT NOT NULL,
  instructor         TEXT NOT NULL,
  slot_number        INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 6),
  customer_name      TEXT NOT NULL,
  customer_phone     TEXT NOT NULL,
  confirmation_code  TEXT NOT NULL,                -- required alongside id to cancel/modify
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),

  -- The core guarantee: two people can never hold the same seat in the same
  -- session. SQLite enforces this per-INSERT, so it holds even under
  -- concurrent requests without any extra locking.
  UNIQUE (class_date, session_time, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings (class_date, session_time);
