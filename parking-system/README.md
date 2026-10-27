# Parking Register

Express + HTML/CSS/JS + Neon PostgreSQL.

## Run
1. Install Node.js 18+.
2. In this folder: `npm install`
3. `npm start`
4. Open http://localhost:3000

Tables, slots (20 car, 30 bike) and the two logins are created automatically on first start.

## Logins (change in .env before first start)
- Admin: `admin` / `Admin@123`  (Admin tab)
- User:  `user`  / `User@123`   (User tab)

If you change a password after the first start, the old hash stays in the `users` table;
delete the row (`DELETE FROM users WHERE username='admin';`) and restart.

## Roles
- Admin: Add, Unpark, Cancel booking, change usernames/passwords (Accounts tab), plus everything the user can do.
- User: Current parked, Search, Available slots, Book slot (no Add / Unpark).

## Change slot counts
Edit CAR_SLOTS / BIKE_SLOTS in .env and restart (it only adds missing slots).
