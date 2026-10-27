
1. Install Node.js 18+.
2. In this folder: `npm install`
3. `npm start`
4. http://localhost:3000

(20 car, 30 bike)
- Admin: `admin` / `Admin@123`  (Admin tab)
- User:  `user`  / `User@123`   (User tab)

If you change a password after the first start, the old hash stays in the `users` table;
delete the row (`DELETE FROM users WHERE username='admin';`) and restart.

## Roles
- Admin: Add, Unpark, Cancel booking, plus everything the user can do.
- User: Current parked, Search, Available slots, Book slot (no Add / Unpark).

## Change slot counts
Edit CAR_SLOTS / BIKE_SLOTS in .env and restart (it only adds missing slots).
