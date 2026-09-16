// Studio Noor booking API — Cloudflare Worker + D1.
//
// Slots are numbered 1-6 per session (one per reformer). The UNIQUE
// constraint on (class_date, session_time, slot_number) in schema.sql is
// what actually prevents two people from booking the same slot: booking
// tries an INSERT for each free-looking slot number and lets SQLite reject
// a duplicate, so the guarantee holds even if two requests land at once.
//
// Cancelling or changing a booking is only allowed while the class is still
// at least 24 hours away, checked against class_date + session_time in the
// studio's own timezone (Asia/Dubai, UTC+4, no DST).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const STUDIO_UTC_OFFSET = '+04:00';
const MAX_SLOTS = 6;
const CANCEL_WINDOW_HOURS = 24;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isValidDate(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function isValidTime(str) {
  return typeof str === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

function classStartMs(date, time) {
  return new Date(date + 'T' + time + ':00' + STUDIO_UTC_OFFSET).getTime();
}

function hoursUntil(date, time) {
  return (classStartMs(date, time) - Date.now()) / 3600000;
}

function genId() {
  return crypto.randomUUID();
}

function genConfirmationCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function isUniqueConstraintError(err) {
  return String((err && err.message) || err).toUpperCase().includes('UNIQUE');
}

// Tries slot 1..6 in order and returns the row it managed to insert, or
// null if every slot in that session is already taken.
async function insertIntoFirstFreeSlot(db, fields) {
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    try {
      await db
        .prepare(
          `INSERT INTO bookings
             (id, class_date, session_time, class_name, instructor, slot_number, customer_name, customer_phone, confirmation_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          fields.id,
          fields.classDate,
          fields.sessionTime,
          fields.className,
          fields.instructor,
          slot,
          fields.customerName,
          fields.customerPhone,
          fields.confirmationCode
        )
        .run();
      return slot;
    } catch (err) {
      if (isUniqueConstraintError(err)) continue;
      throw err;
    }
  }
  return null;
}

async function updateIntoFirstFreeSlot(db, bookingId, fields) {
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    try {
      await db
        .prepare(
          `UPDATE bookings
           SET class_date = ?, session_time = ?, class_name = ?, instructor = ?, slot_number = ?
           WHERE id = ?`
        )
        .bind(fields.classDate, fields.sessionTime, fields.className, fields.instructor, slot, bookingId)
        .run();
      return slot;
    } catch (err) {
      if (isUniqueConstraintError(err)) continue;
      throw err;
    }
  }
  return null;
}

async function handleAvailability(url, env) {
  const date = url.searchParams.get('date');
  const time = url.searchParams.get('time');
  if (!isValidDate(date) || !isValidTime(time)) {
    return json({ error: 'Valid date (YYYY-MM-DD) and time (HH:MM) are required' }, 400);
  }
  const { results } = await env.DB.prepare(
    'SELECT slot_number FROM bookings WHERE class_date = ? AND session_time = ?'
  )
    .bind(date, time)
    .all();
  return json({
    date,
    time,
    totalSlots: MAX_SLOTS,
    bookedSlots: results.map(function (r) { return r.slot_number; }),
  });
}

async function handleBook(request, env) {
  const body = await request.json().catch(function () { return null; });
  if (!body) return json({ error: 'Invalid JSON body' }, 400);

  const { date, time, className, instructor, name, phone } = body;
  if (!isValidDate(date) || !isValidTime(time)) {
    return json({ error: 'Valid date (YYYY-MM-DD) and time (HH:MM) are required' }, 400);
  }
  if (!className || !instructor || !name || !phone) {
    return json({ error: 'className, instructor, name and phone are required' }, 400);
  }
  if (classStartMs(date, time) <= Date.now()) {
    return json({ error: 'This session has already started or has passed' }, 400);
  }

  const id = genId();
  const confirmationCode = genConfirmationCode();
  const slot = await insertIntoFirstFreeSlot(env.DB, {
    id: id,
    classDate: date,
    sessionTime: time,
    className: className,
    instructor: instructor,
    customerName: name,
    customerPhone: phone,
    confirmationCode: confirmationCode,
  });

  if (slot === null) return json({ error: 'This session is fully booked' }, 409);
  return json({ bookingId: id, slot: slot, confirmationCode: confirmationCode }, 201);
}

async function lookupBooking(env, id, code) {
  return env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND confirmation_code = ?')
    .bind(id, code)
    .first();
}

async function handleGetBooking(url, env) {
  const id = url.searchParams.get('id');
  const code = url.searchParams.get('code');
  if (!id || !code) return json({ error: 'id and code are required' }, 400);

  const row = await lookupBooking(env, id, code);
  if (!row) return json({ error: 'Booking not found' }, 404);

  const hoursLeft = hoursUntil(row.class_date, row.session_time);
  return json({ booking: row, hoursUntilClass: hoursLeft, canChange: hoursLeft >= CANCEL_WINDOW_HOURS });
}

async function handleCancel(request, env) {
  const body = await request.json().catch(function () { return null; });
  if (!body) return json({ error: 'Invalid JSON body' }, 400);

  const { bookingId, confirmationCode } = body;
  if (!bookingId || !confirmationCode) {
    return json({ error: 'bookingId and confirmationCode are required' }, 400);
  }

  const row = await lookupBooking(env, bookingId, confirmationCode);
  if (!row) return json({ error: 'Booking not found' }, 404);

  const hoursLeft = hoursUntil(row.class_date, row.session_time);
  if (hoursLeft < CANCEL_WINDOW_HOURS) {
    return json(
      { error: 'Cancellations must be made at least 24 hours before the class starts', hoursUntilClass: hoursLeft },
      400
    );
  }

  await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(bookingId).run();
  return json({ ok: true });
}

async function handleModify(request, env) {
  const body = await request.json().catch(function () { return null; });
  if (!body) return json({ error: 'Invalid JSON body' }, 400);

  const { bookingId, confirmationCode, newDate, newTime, className, instructor } = body;
  if (!bookingId || !confirmationCode) {
    return json({ error: 'bookingId and confirmationCode are required' }, 400);
  }
  if (!isValidDate(newDate) || !isValidTime(newTime) || !className || !instructor) {
    return json({ error: 'newDate, newTime, className and instructor are required' }, 400);
  }

  const row = await lookupBooking(env, bookingId, confirmationCode);
  if (!row) return json({ error: 'Booking not found' }, 404);

  const hoursLeft = hoursUntil(row.class_date, row.session_time);
  if (hoursLeft < CANCEL_WINDOW_HOURS) {
    return json(
      {
        error: 'Changes must be made at least 24 hours before the original class starts',
        hoursUntilClass: hoursLeft,
      },
      400
    );
  }
  if (classStartMs(newDate, newTime) <= Date.now()) {
    return json({ error: 'The new session has already started or has passed' }, 400);
  }

  const slot = await updateIntoFirstFreeSlot(env.DB, bookingId, {
    classDate: newDate,
    sessionTime: newTime,
    className: className,
    instructor: instructor,
  });

  if (slot === null) return json({ error: 'The new session is fully booked' }, 409);
  return json({ ok: true, slot: slot });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true });
      }
      if (url.pathname === '/api/availability' && request.method === 'GET') {
        return await handleAvailability(url, env);
      }
      if (url.pathname === '/api/book' && request.method === 'POST') {
        return await handleBook(request, env);
      }
      if (url.pathname === '/api/booking' && request.method === 'GET') {
        return await handleGetBooking(url, env);
      }
      if (url.pathname === '/api/cancel' && request.method === 'POST') {
        return await handleCancel(request, env);
      }
      if (url.pathname === '/api/modify' && request.method === 'POST') {
        return await handleModify(request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Server error', detail: String((err && err.message) || err) }, 500);
    }
  },
};
