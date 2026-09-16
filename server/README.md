# Studio Noor booking API

A small Cloudflare Worker + D1 (SQLite) backend that makes booking real:
once a slot is booked, the database itself refuses a second booking for the
same session and slot number — no two people can ever hold the same seat.
Cancelling or changing a booking is only allowed while the class is still at
least 24 hours away.

This lives outside the static site because booking needs a server that
every visitor's browser shares — a plain HTML/CSS/JS page can't enforce
"only one person gets this seat" on its own.

## Endpoints

| Method | Path              | Purpose                                   |
| ------ | ----------------- | ------------------------------------------ |
| GET    | `/api/availability?date=YYYY-MM-DD&time=HH:MM` | Which of the 6 slots are already booked |
| POST   | `/api/book`       | Book the first free slot in a session      |
| GET    | `/api/booking?id=&code=` | Look up a booking (needs its id + confirmation code) |
| POST   | `/api/cancel`     | Cancel a booking (>= 24h before class only) |
| POST   | `/api/modify`     | Move a booking to a new session (>= 24h before the *original* class only) |

All responses are JSON. See `src/index.js` for exact request bodies.

## Deploying it (one-time setup, ~5 minutes)

You'll need a free Cloudflare account.

```bash
cd server
npm install

# Log in to Cloudflare (opens a browser window)
npx wrangler login

# Create the database — copy the database_id it prints
npx wrangler d1 create studio-noor-bookings
```

Paste that `database_id` into `wrangler.toml` (replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`), then:

```bash
# Create the bookings table on the real (remote) database
npx wrangler d1 execute studio-noor-bookings --remote --file=./schema.sql

# Ship it
npx wrangler deploy
```

`wrangler deploy` prints your Worker's live URL, something like
`https://studio-noor-booking.<your-subdomain>.workers.dev`. Put that URL into
`API_BASE_URL` near the top of the `<script>` block in `../index.html` —
that's the only change needed on the site side to go live.

## Local testing

```bash
npx wrangler dev
```

This runs the API on `http://localhost:8787` against a local copy of the
database, so you can test booking/cancelling without touching real data.
