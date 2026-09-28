# Dr. Mrinmoy Ray – Clinic Booking (with real admin login)

Patients book a slot online. The slot is held immediately for everyone.
Staff log in with ID + password to confirm/cancel bookings and block slots.
New bookings are sent to 87770 19294 automatically (SMS/WhatsApp via Twilio, optional).

No dependencies. Needs only Node.js 18 or newer.

## Run on your own computer
    node server.js
Open http://localhost:3000  (admin: footer -> "Admin")

Admin login is set in `.env`:
    ADMIN_ID=drray-admin
    ADMIN_PASSWORD=WBDdf2jjAK52      <- change this before going live

## Put it online (pick one)
Render / Railway / any Node host
1. Upload this folder to a GitHub repo (`.env` is git-ignored; add the values in the host's Environment settings instead).
2. Start command: `node server.js`
3. Environment variables: ADMIN_ID, ADMIN_PASSWORD, SESSION_SECRET, ADMIN_PHONE, TRUST_PROXY=1
4. Add a persistent disk and set `DATA_FILE=/data/data.json`, otherwise bookings are lost on redeploy.

A VPS (Ubuntu): install Node, copy the folder, run with `pm2 start server.js`, put nginx + HTTPS (Let's Encrypt) in front.
Always use HTTPS in production, because the admin password travels over the network.

## Automatic messages to 87770 19294
Without Twilio, booking still works; the admin panel shows new requests (refreshes every 30 s).
For an automatic message on the phone, create a Twilio account and fill in `.env`:
    TWILIO_ACCOUNT_SID=...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM=+1XXXXXXXXXX              (SMS)
    or for WhatsApp: TWILIO_FROM=whatsapp:+14155238886
Indian SMS delivery has DLT registration rules, so WhatsApp is usually easier to start with
(the recipient must join the Twilio sandbox first, or you need an approved WhatsApp sender).
Failures are logged and never block a patient's booking.

## Change timings
Edit CONFIG at the top of `server.js` (sessions, slot length, days ahead), then restart.

## Files
- server.js  - API, admin login, storage (data.json), notifications
- public/    - the website (index.html, app.js, style.css)
- .env       - settings and admin credentials (keep private)
