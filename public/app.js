/* ---------- session ---------- */
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user) location.href = '/login.html';
const isAdmin = user && user.role === 'admin';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.href = '/login.html';
}

/* ---------- formatting ---------- */
const fmt = (d) => d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '–';
function duration(from, to) {
  const mins = Math.max(0, Math.floor(((to ? new Date(to) : new Date()) - new Date(from)) / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
}
function say(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
}
const typeLabel = (t) => (t === 'car' ? 'Car' : 'Bike');

/* ---------- stats ---------- */
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('carParked').textContent = s.car.parked;
    $('carAvail').textContent = s.car.available;
    $('carBooked').textContent = s.car.booked;
    $('bikeParked').textContent = s.bike.parked;
    $('bikeAvail').textContent = s.bike.available;
    $('bikeBooked').textContent = s.bike.booked;
    $('allParked').textContent = s.car.parked + s.bike.parked;
    $('allAvail').textContent = s.car.available + s.bike.available;
  } catch (e) { /* counts stay as dashes */ }
}

/* ---------- navigation ---------- */
const views = ['add', 'current', 'search', 'slots', 'book'];
const state = { current: 'car', slots: 'car' };

function showView(name) {
  views.forEach((v) => { $('view-' + v).hidden = v !== name; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'current') loadCurrent();
  if (name === 'slots') loadSlots();
  if (name === 'book') { loadBookSlots(); loadBookings(); }
  if (name === 'search') $('searchPlate').focus();
  if (name === 'add') $('addPlate').focus();
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

document.querySelectorAll('.seg[data-seg]').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = seg.dataset.seg;
    state[key] = btn.dataset.type;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    key === 'current' ? loadCurrent() : loadSlots();
  });
});

/* ---------- ADD ---------- */
function addType() { return document.querySelector('input[name=type]:checked').value; }
document.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', () => {
  const t = addType();
  $('addModelLabel').textContent = typeLabel(t) + ' model';
  $('addModel').placeholder = t === 'car' ? 'e.g. Honda City' : 'e.g. Splendor Plus';
}));

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('/api/park', {
      method: 'POST',
      body: JSON.stringify({ type: addType(), plate: $('addPlate').value, model: $('addModel').value }),
    });
    say($('addMsg'), `${r.plate} added to slot ${r.slot_no} on ${fmt(r.entry_time)}.`, true);
    $('addPlate').value = ''; $('addModel').value = '';
    $('addPlate').focus();
    loadStats();
  } catch (err) { say($('addMsg'), err.message, false); }
  btn.disabled = false;
});

/* ---------- CURRENT ---------- */
async function loadCurrent() {
  const table = $('currentTable');
  say($('currentMsg'), '', true);
  try {
    const rows = await api('/api/current?type=' + state.current);
    if (!rows.length) {
      table.innerHTML = `<tbody><tr><td class="empty">No ${state.current === 'car' ? 'cars' : 'bikes'} are parked right now.</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `
      <thead><tr><th>Number plate</th><th>Model</th><th>Slot</th><th>Parked since</th><th>Time parked</th>${isAdmin ? '<th>Action</th>' : ''}</tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td class="plate">${esc(r.number_plate)}</td>
          <td>${esc(r.model)}</td>
          <td>${esc(r.slot_no)}</td>
          <td>${fmt(r.entry_time)}</td>
          <td>${duration(r.entry_time)}</td>
          ${isAdmin ? `<td><button class="btn danger" data-unpark="${r.id}" data-plate="${esc(r.number_plate)}">Unpark</button></td>` : ''}
        </tr>`).join('')}</tbody>`;
  } catch (err) { say($('currentMsg'), err.message, false); }
}

$('currentTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-unpark]');
  if (!btn) return;
  if (!confirm(`Unpark ${btn.dataset.plate}?`)) return;
  try {
    await api(`/api/unpark/${state.current}/${btn.dataset.unpark}`, { method: 'POST' });
    say($('currentMsg'), `${btn.dataset.plate} unparked.`, true);
    loadStats();
    const msg = $('currentMsg').textContent;
    await loadCurrent();
    say($('currentMsg'), msg, true);
  } catch (err) { say($('currentMsg'), err.message, false); }
});

/* ---------- SEARCH ---------- */
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('searchResults');
  out.innerHTML = '';
  say($('searchMsg'), '', true);
  try {
    const r = await api('/api/search?plate=' + encodeURIComponent($('searchPlate').value));
    if (!r.history.length && !r.bookings.length) {
      say($('searchMsg'), 'No records found for that number plate.', false);
      return;
    }
    let html = '';
    if (r.history.length) {
      html += `<div class="result-block"><h3>Parking history</h3><div class="table-wrap"><table>
        <thead><tr><th>Number plate</th><th>Type</th><th>Model</th><th>Slot</th><th>Parked at</th><th>Unparked at</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody>${r.history.map((h) => `
          <tr>
            <td class="plate">${esc(h.number_plate)}</td><td>${typeLabel(h.vehicle_type)}</td><td>${esc(h.model)}</td><td>${esc(h.slot_no)}</td>
            <td>${fmt(h.entry_time)}</td><td>${fmt(h.exit_time)}</td><td>${duration(h.entry_time, h.exit_time)}</td>
            <td><span class="tag ${h.status}">${h.status === 'parked' ? 'Parked' : 'Unparked'}</span></td>
          </tr>`).join('')}</tbody></table></div></div>`;
    }
    if (r.bookings.length) {
      html += `<div class="result-block"><h3>Bookings</h3><div class="table-wrap"><table>
        <thead><tr><th>Number plate</th><th>Type</th><th>Slot</th><th>Booked at</th><th>Status</th></tr></thead>
        <tbody>${r.bookings.map((b) => `
          <tr>
            <td class="plate">${esc(b.number_plate)}</td><td>${typeLabel(b.vehicle_type)}</td><td>${esc(b.slot_no)}</td><td>${fmt(b.booked_at)}</td>
            <td><span class="tag ${b.status}">${b.status[0].toUpperCase() + b.status.slice(1)}</span></td>
          </tr>`).join('')}</tbody></table></div></div>`;
    }
    out.innerHTML = html;
  } catch (err) { say($('searchMsg'), err.message, false); }
});

/* ---------- SLOTS ---------- */
async function loadSlots() {
  const grid = $('slotGrid');
  try {
    const slots = await api('/api/slots?type=' + state.slots);
    const label = { free: 'Free', booked: 'Booked', occupied: 'Parked' };
    grid.innerHTML = slots.map((s) => `
      <div class="bay ${s.state}">
        <span class="bay-no">${esc(s.slot_no)}</span>
        <span class="bay-plate">${esc(s.parked_plate || s.booked_plate || '')}</span>
        <span class="bay-state">${label[s.state]}</span>
      </div>`).join('');
  } catch (err) { grid.textContent = err.message; }
}

/* ---------- BOOK ---------- */
function bookType() { return document.querySelector('input[name=btype]:checked').value; }
document.querySelectorAll('input[name=btype]').forEach((r) => r.addEventListener('change', loadBookSlots));

async function loadBookSlots() {
  const sel = $('bookSlot');
  try {
    const slots = await api('/api/slots?type=' + bookType());
    sel.innerHTML = '<option value="">Any free slot</option>' +
      slots.filter((s) => s.state === 'free').map((s) => `<option value="${s.id}">${esc(s.slot_no)}</option>`).join('');
  } catch (err) { /* keep default option */ }
}

async function loadBookings() {
  const table = $('bookingsTable');
  try {
    const rows = await api('/api/bookings');
    if (!rows.length) { table.innerHTML = '<tbody><tr><td class="empty">No active bookings.</td></tr></tbody>'; return; }
    table.innerHTML = `
      <thead><tr><th>Number plate</th><th>Type</th><th>Slot</th><th>Booked at</th><th>Booked by</th>${isAdmin ? '<th>Action</th>' : ''}</tr></thead>
      <tbody>${rows.map((b) => `
        <tr>
          <td class="plate">${esc(b.number_plate)}</td><td>${typeLabel(b.vehicle_type)}</td><td>${esc(b.slot_no)}</td>
          <td>${fmt(b.booked_at)}</td><td>${esc(b.booked_by)}</td>
          ${isAdmin ? `<td><button class="btn danger" data-cancel="${b.id}" data-plate="${esc(b.number_plate)}">Cancel</button></td>` : ''}
        </tr>`).join('')}</tbody>`;
  } catch (err) { table.innerHTML = `<tbody><tr><td class="empty">${esc(err.message)}</td></tr></tbody>`; }
}

$('bookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('/api/book', {
      method: 'POST',
      body: JSON.stringify({ type: bookType(), plate: $('bookPlate').value, slot_id: $('bookSlot').value || null }),
    });
    say($('bookMsg'), `Slot ${r.slot_no} booked for ${r.plate}.`, true);
    $('bookPlate').value = '';
    loadStats(); loadBookSlots(); loadBookings();
  } catch (err) { say($('bookMsg'), err.message, false); }
  btn.disabled = false;
});

$('bookingsTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  if (!confirm(`Cancel the booking for ${btn.dataset.plate}?`)) return;
  try {
    await api(`/api/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST' });
    loadStats(); loadBookSlots(); loadBookings();
  } catch (err) { say($('bookMsg'), err.message, false); }
});

/* ---------- start ---------- */
if (user) {
  $('whoLabel').textContent = `${user.username} (${isAdmin ? 'Admin' : 'User'})`;
  $('logoutBtn').addEventListener('click', logout);
  if (!isAdmin) $('navAdd').hidden = true; // users cannot add data
  loadStats();
  setInterval(loadStats, 30000);
  showView(isAdmin ? 'add' : 'current');
}
