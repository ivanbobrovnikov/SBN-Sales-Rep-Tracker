const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3400;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-session";
const OWNER_PASSWORD_HASH_ENV = process.env.OWNER_PASSWORD_HASH || "";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");

function hash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function newId() {
  return crypto.randomBytes(8).toString("hex");
}
function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    const fresh = { locations: [], goals: [], ownerPasswordHash: OWNER_PASSWORD_HASH_ENV || null };
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!db.locations) db.locations = [];
  if (!db.goals) db.goals = [];
  if (!db.sounds) db.sounds = [];
  if (!db.repSounds) db.repSounds = [];
  if (!db.repPhotos) db.repPhotos = [];
  if (!db.tv) db.tv = { keyHash: null, createdAt: null, settings: { defaultSound: "random", volume: "medium" } };
  if (!db.tv.settings) db.tv.settings = { defaultSound: "random", volume: "medium" };
  if (!db.tv.settings.soundMethod) db.tv.settings.soundMethod = "auto";
  if (db.tv.settings.confetti === undefined) db.tv.settings.confetti = true;
  if (!db.tv.reports) db.tv.reports = [];
  if (!db.tv.test) db.tv.test = { seq: 0, sound: null };
  if (db.ownerPasswordHash === undefined) db.ownerPasswordHash = OWNER_PASSWORD_HASH_ENV || null;
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// Logins signed before this moment are no longer accepted. Zero (the normal state) cuts nobody off; "Change password" can set it to log every other device out.
let sessionsValidAfter = 0;
try { sessionsValidAfter = Number(loadDB().sessionsValidAfter) || 0; } catch (e) { sessionsValidAfter = 0; }

// ---------- Auth: single owner password, no roles - this tool is owner-only ----------
function signSession() {
  const payload = JSON.stringify({ role: "owner", ts: Date.now() });
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64") + "." + sig;
}
function verifySession(token) {
  if (!token) return false;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;
  const payload = Buffer.from(payloadB64, "base64").toString("utf8");
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  if (sig !== expectedSig) return false;
  if (sessionsValidAfter > 0) { try { if (!(JSON.parse(payload).ts >= sessionsValidAfter)) return false; } catch (e) { return false; } }
  return true;
}
function requireOwner(req, res, next) {
  if (!verifySession(req.cookies.session)) return res.status(401).json({ error: "Not logged in." });
  next();
}

app.get("/api/session", (req, res) => {
  const db = loadDB();
  res.json({ loggedIn: verifySession(req.cookies.session), needsSetup: !db.ownerPasswordHash });
});

app.post("/api/setup/owner-password", (req, res) => {
  const db = loadDB();
  if (db.ownerPasswordHash) return res.status(400).json({ error: "Already set up." });
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
  db.ownerPasswordHash = hash(password);
  saveDB(db);
  res.cookie("session", signSession(), { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const db = loadDB();
  const { password } = req.body;
  if (!db.ownerPasswordHash || hash(password) !== db.ownerPasswordHash) return res.status(401).json({ error: "Wrong password." });
  res.cookie("session", signSession(), { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

// ---------- Location management ----------
app.get("/api/locations", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.locations.map((l) => ({ id: l.id, name: l.name, url: l.url })));
});

app.post("/api/locations", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, url, secret } = req.body;
  if (!name || !url || !secret) return res.status(400).json({ error: "Name, URL, and secret are all required." });
  const entry = { id: newId(), name: name.trim(), url: url.trim().replace(/\/$/, ""), secret: secret.trim() };
  db.locations.push(entry);
  saveDB(db);
  res.json({ ok: true, id: entry.id });
});

app.delete("/api/locations/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.locations = db.locations.filter((l) => l.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Goals - one per rep per cadence, matched by rep name across locations ----------
app.get("/api/goals", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.goals);
});

app.post("/api/goals", requireOwner, (req, res) => {
  const db = loadDB();
  const { repName, metric, cadence, target } = req.body;
  if (!repName || !["commission", "closes", "value"].includes(metric) || !["week", "month"].includes(cadence) || !target) {
    return res.status(400).json({ error: "Rep, metric, cadence, and a real target are all required." });
  }
  // Only one active goal per rep+cadence+metric - setting a new one replaces the old.
  db.goals = db.goals.filter((g) => !(g.repName === repName && g.cadence === cadence && g.metric === metric));
  const goal = { id: newId(), repName, metric, cadence, target: parseFloat(target) };
  db.goals.push(goal);
  saveDB(db);
  res.json({ ok: true, goal });
});

app.delete("/api/goals/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.goals = db.goals.filter((g) => g.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Combined stats - fetches raw close records from every configured location
// and computes everything from them here, so each real tracker's own endpoint stays simple.
async function fetchLocationCloses(loc, qs) {
  const r = await fetch(`${loc.url}/api/cross-location/salesrep-closes?secret=${encodeURIComponent(loc.secret)}&${qs}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function periodQueryString(query) {
  const period = query.period || "month";
  const params = { period };
  if (query.date) params.date = query.date;
  if (query.month) params.month = query.month;
  if (query.startDate) { params.startDate = query.startDate; params.endDate = query.endDate; }
  if (query.dateBasis === "closed") params.dateBasis = "closed";
  return new URLSearchParams(params).toString();
}

// The combined sales rep numbers, lifted out of the route so the TV feed uses exactly the numbers the web leaderboard uses.
async function buildCombinedStats(db, query) {
  const qs = periodQueryString(query);
  const results = [];
  const errors = [];
  await Promise.all(db.locations.map(async (loc) => {
    try {
      const data = await fetchLocationCloses(loc, qs);
      results.push({ locationId: loc.id, locationName: loc.name, perRep: data.perRep || [], leftOut: data.leftOut || [] });
    } catch (e) {
      errors.push({ locationId: loc.id, locationName: loc.name, error: e.message || "Unreachable" });
    }
  }));

  // Merge by rep name into one big list of closes, tagged with which location each came from.
  const byRep = {};
  results.forEach((loc) => {
    loc.perRep.forEach((r) => {
      if (!byRep[r.name]) byRep[r.name] = { name: r.name, closes: [] };
      r.closes.forEach((c) => byRep[r.name].closes.push({ ...c, locationId: loc.locationId, locationName: loc.locationName }));
    });
  });

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const perRep = Object.values(byRep).map((rep) => {
    const closes = rep.closes;
    const arrived = closes.filter((c) => c.status === "arrived");
    const noShow = closes.filter((c) => c.status === "no_show");
    const pending = closes.filter((c) => c.status !== "arrived" && c.status !== "no_show");
    const closedValue = closes.reduce((a, c) => a + c.basePrice, 0);
    const avgDealSize = closes.length ? closedValue / closes.length : 0;
    const duringHoursCount = closes.filter((c) => c.duringHours).length;
    const afterHoursCount = closes.length - duringHoursCount;

    // Commission needs each close's own location's rate, since rates can differ by
    // location - looked up from that location's perRep entry for this rep name.
    const rateFor = (locId, duringHours) => {
      const loc = results.find((l) => l.locationId === locId);
      const repAtLoc = loc ? loc.perRep.find((r) => r.name === rep.name) : null;
      if (!repAtLoc) return 0;
      return duringHours ? repAtLoc.commissionRate : repAtLoc.afterHoursCommissionRate;
    };
    let actualCommission = 0, projectedCommission = 0;
    closes.forEach((c) => {
      const rate = rateFor(c.locationId, c.duringHours);
      const amt = c.basePrice * (rate / 100);
      c.commissionAmount = amt; // attached per-close so the frontend never has to approximate when filtering to one location
      projectedCommission += amt;
      if (c.status === "arrived") actualCommission += amt;
    });

    // By location
    const byLocation = {};
    closes.forEach((c) => {
      if (!byLocation[c.locationName]) byLocation[c.locationName] = { locationName: c.locationName, closeCount: 0, closedValue: 0, arrivedCount: 0 };
      byLocation[c.locationName].closeCount += 1;
      byLocation[c.locationName].closedValue += c.basePrice;
      if (c.status === "arrived") byLocation[c.locationName].arrivedCount += 1;
    });

    // By service
    const byService = {};
    closes.forEach((c) => {
      const key = c.baseService || "(not set)";
      byService[key] = (byService[key] || 0) + 1;
    });

    // By day of week (using closedAt - when the deal was actually closed)
    const byDayOfWeek = dayNames.map((name) => ({ day: name, count: 0 }));
    closes.forEach((c) => {
      const d = new Date(c.closedAt);
      if (!isNaN(d.getTime())) byDayOfWeek[d.getUTCDay()].count += 1;
    });

    // Days since last close
    const sorted = [...closes].sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
    const lastCloseAt = sorted.length ? sorted[0].closedAt : null;
    const daysSinceLastClose = lastCloseAt ? Math.floor((Date.now() - new Date(lastCloseAt).getTime()) / (1000 * 60 * 60 * 24)) : null;

    // Possible duplicates: same customer name closed at more than one location within
    // the period - very likely one person mistakenly counted twice, or worth a glance.
    const byCustomer = {};
    closes.forEach((c) => { (byCustomer[(c.customerName || "").trim().toLowerCase()] = byCustomer[(c.customerName || "").trim().toLowerCase()] || []).push(c); });
    const possibleDuplicates = Object.values(byCustomer)
      .filter((group) => group.length > 1 && new Set(group.map((c) => c.locationName)).size > 1)
      .map((group) => ({ customerName: group[0].customerName, entries: group.map((c) => ({ car: c.car, locationName: c.locationName, date: c.date, basePrice: c.basePrice })) }));

    return {
      name: rep.name, closeCount: closes.length, closedValue, avgDealSize,
      arrivedCount: arrived.length, noShowCount: noShow.length, pendingCount: pending.length,
      noShowRate: (arrived.length + noShow.length) > 0 ? (noShow.length / (arrived.length + noShow.length)) * 100 : 0,
      actualCommission, projectedCommission, duringHoursCount, afterHoursCount,
      byLocation: Object.values(byLocation), byService, byDayOfWeek,
      daysSinceLastClose, possibleDuplicates,
      closes: closes.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1)),
    };
  }).sort((a, b) => b.closeCount - a.closeCount);

  // Bookings the owner marked as reschedules are kept out of the closing numbers; they come through here so the
  // Audit tab can list them and offer an undo.
  const leftOut = results.flatMap((l) => (l.leftOut || []).map((x) => ({ ...x, locationId: l.locationId, locationName: l.locationName })));
  return { perRep, errors, locationsQueried: results.map((r) => r.locationName), leftOut };
}
app.get("/api/combined/salesrep-stats", requireOwner, async (req, res) => res.json(await buildCombinedStats(loadDB(), req.query)));

// ---------- Combined Cleanup ----------
app.get("/api/combined/cleanup-list", requireOwner, async (req, res) => {
  const db = loadDB();
  const all = [];
  const possibleReschedules = [], leftOut = [], recentMerges = [];
  const errors = [];
  await Promise.all(db.locations.map(async (loc) => {
    try {
      const r = await fetch(`${loc.url}/api/cross-location/cleanup-list?secret=${encodeURIComponent(loc.secret)}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      (data.jobs || []).forEach((j) => all.push({ ...j, locationId: loc.id, locationName: loc.name }));
      (data.possibleReschedules || []).forEach((j) => possibleReschedules.push({ ...j, locationId: loc.id, locationName: loc.name }));
      (data.leftOut || []).forEach((j) => leftOut.push({ ...j, locationId: loc.id, locationName: loc.name }));
      (data.recentMerges || []).forEach((j) => recentMerges.push({ ...j, locationId: loc.id, locationName: loc.name }));
    } catch (e) {
      errors.push({ locationName: loc.name, error: e.message || "Unreachable" });
    }
  }));
  res.json({ jobs: all.sort((a, b) => (a.date < b.date ? 1 : -1)), errors, possibleReschedules: possibleReschedules.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1)), leftOut: leftOut.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1)), recentMerges: recentMerges.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1)) });
});

app.post("/api/combined/cleanup-fix", requireOwner, async (req, res) => {
  const db = loadDB();
  const { locationId, saleId, ...fix } = req.body;
  const loc = db.locations.find((l) => l.id === locationId);
  if (!loc) return res.status(404).json({ error: "Location not found." });
  try {
    const r = await fetch(`${loc.url}/api/cross-location/cleanup-fix?secret=${encodeURIComponent(loc.secret)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saleId, ...fix }), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { const err = await r.json().catch(() => ({})); return res.status(r.status).json({ error: err.error || `HTTP ${r.status}` }); }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "Couldn't reach that location." });
  }
});

// ---------- Editing and adding jobs at a location ----------
// Calls one of a location's cross-location endpoints and reports back plainly. A location that hasn't
// been updated yet doesn't have these endpoints at all, which comes back as a web page rather than
// JSON - so that gets a clear "needs the update" message instead of a confusing failure.
async function callLocation(loc, path, body) {
  const url = `${loc.url}${path}${path.includes("?") ? "&" : "?"}secret=${encodeURIComponent(loc.secret)}`;
  const r = await fetch(url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  // Not JSON and either "not found" or a normal page = this isn't our API (an older tracker). A 5xx page is just an outage.
  return { status: r.status, ok: r.ok, data, notOurApi: data === null && (r.status === 404 || r.ok) };
}
const NEEDS_UPDATE = (name) => `${name} needs the latest tracker update before jobs can be edited from here.`;

app.get("/api/combined/salesreps", requireOwner, async (req, res) => {
  const db = loadDB();
  const out = await Promise.all(db.locations.map(async (loc) => {
    const base = { locationId: loc.id, locationName: loc.name, salesReps: [] };
    try {
      const r = await callLocation(loc, "/api/cross-location/salesreps");
      if (r.notOurApi) return { ...base, needsUpdate: true };
      if (!r.ok) return { ...base, error: (r.data && r.data.error) || `HTTP ${r.status}` };
      return { ...base, salesReps: r.data.salesReps || [] };
    } catch (e) { return { ...base, error: e.message || "Unreachable" }; }
  }));
  res.json({ locations: out });
});

async function proxyWrite(req, res, path) {
  const db = loadDB();
  const { locationId, ...rest } = req.body;
  const loc = db.locations.find((l) => l.id === locationId);
  if (!loc) return res.status(404).json({ error: "Location not found." });
  try {
    const r = await callLocation(loc, path, rest);
    if (r.notOurApi) return res.status(409).json({ error: NEEDS_UPDATE(loc.name), needsUpdate: true });
    if (!r.ok) return res.status(r.status).json(r.data || { error: `HTTP ${r.status}` });
    res.json(r.data || { ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "Couldn't reach that location." });
  }
}
app.post("/api/combined/job-edit", requireOwner, (req, res) => proxyWrite(req, res, "/api/cross-location/job-edit"));
app.post("/api/combined/job-add", requireOwner, (req, res) => proxyWrite(req, res, "/api/cross-location/job-add"));
app.post("/api/combined/job-merge", requireOwner, (req, res) => proxyWrite(req, res, "/api/cross-location/job-merge"));

// ---------- Change password (Settings) ----------
// Needs the CURRENT password even though you're logged in, so a phone left unlocked can't be used to lock you out. After 5 wrong tries it refuses for 15 minutes.
const pwTries = { count: 0, lockedUntil: 0 };
app.post("/api/change-password", requireOwner, (req, res) => {
  const now = Date.now();
  if (pwTries.lockedUntil > now) return res.status(429).json({ error: "Too many wrong tries. Wait a few minutes and try again." });
  const { currentPassword, newPassword, logOutOthers } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") return res.status(400).json({ error: "Enter your current password and a new one." });
  const db = loadDB();
  if (!db.ownerPasswordHash || hash(currentPassword) !== db.ownerPasswordHash) {
    pwTries.count += 1;
    if (pwTries.count >= 5) { pwTries.lockedUntil = now + 15 * 60 * 1000; pwTries.count = 0; }
    return res.status(401).json({ error: "The current password isn't right." });
  }
  pwTries.count = 0;
  if (newPassword.length < 4) return res.status(400).json({ error: "The new password must be at least 4 characters." });
  if (newPassword === currentPassword) return res.status(400).json({ error: "The new password must be different from the current one." });
  db.ownerPasswordHash = hash(newPassword);
  const others = logOutOthers === true;
  if (others) { sessionsValidAfter = Date.now(); db.sessionsValidAfter = sessionsValidAfter; }   // every login made before this moment stops working
  saveDB(db);
  res.cookie("session", signSession(), { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: "lax" });   // this device stays logged in
  res.json({ ok: true, loggedOutOthers: others });
});
// Lets Settings warn when the Railway recovery variable is still set (it would overwrite the password on every restart). Never reveals its value.
app.get("/api/password-status", requireOwner, (req, res) => {
  res.json({ resetVariableSet: !!process.env.RESET_OWNER_PASSWORD });
});

// Password recovery that leaves all your data alone. Only someone with access to the hosting
// account can set environment variables, so this can't be triggered from the website:
// set RESET_OWNER_PASSWORD, let it redeploy, log in with that password, then DELETE the
// variable (otherwise it re-applies on every restart). Locations and goals are untouched.
if (process.env.RESET_OWNER_PASSWORD) {
  const pw = String(process.env.RESET_OWNER_PASSWORD).trim();
  if (pw.length >= 4) {
    const db = loadDB();
    db.ownerPasswordHash = hash(pw);
    saveDB(db);
    console.log("Owner password was reset from RESET_OWNER_PASSWORD. Remove that variable now so it doesn't re-apply on every restart.");
  } else {
    console.log("RESET_OWNER_PASSWORD is shorter than 4 characters - ignored.");
  }
}


// ---------- Custom deal sounds ----------
// Sounds the owner adds for the leaderboard's "Deal closed!" banner. The files live in the data folder (so every screen, including the TV, gets them);
// only the owner can add, hear-list or delete them. A file is accepted only if its first bytes really are audio, whatever its name says.
const SOUNDS_DIR = path.join(DATA_DIR, "sounds");
const MAX_SOUND_BYTES = 3 * 1024 * 1024;
const MAX_SOUNDS = 20;
function detectAudio(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  const ascii = (a, z) => b.toString("latin1", a, z);
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (ascii(0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (ascii(0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac" };
  if (ascii(4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "audio/webm", ext: "webm" };
  if (ascii(0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {                 // a frame header: MP3 (layer bits set) or raw AAC (layer bits zero)
    if ((b[1] & 0x06) === 0) return { mime: "audio/aac", ext: "aac" };
    if ((b[1] & 0x18) !== 0x08) return { mime: "audio/mpeg", ext: "mp3" };
  }
  return null;
}
const publicSound = (s) => ({ id: s.id, name: s.name, mime: s.mime, size: s.size, addedAt: s.addedAt, tvReady: !!s.tvWav });
app.get("/api/sounds", requireOwner, (req, res) => {
  res.json(loadDB().sounds.map(publicSound));
});
app.post("/api/sounds", requireOwner, express.raw({ type: () => true, limit: MAX_SOUND_BYTES }), (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "No sound was received." });
  const kind = detectAudio(body);
  if (!kind) return res.status(400).json({ error: "That doesn't look like an audio file. Use an MP3, WAV, OGG or M4A." });
  const db = loadDB();
  if (db.sounds.length >= MAX_SOUNDS) return res.status(400).json({ error: `You already have ${MAX_SOUNDS} sounds. Delete one first.` });
  const name = String(req.query.name || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "My sound";   // tabs and line breaks count as spaces; < and > are dropped
  const id = newId();
  try {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SOUNDS_DIR, `${id}.${kind.ext}`), body);
  } catch (e) { return res.status(500).json({ error: "Couldn't save that sound on the server." }); }
  const sound = { id, name, mime: kind.mime, ext: kind.ext, size: body.length, addedAt: new Date().toISOString() };
  db.sounds.push(sound);
  saveDB(db);
  res.json(publicSound(sound));
});
app.get("/api/sounds/:id/file", requireOwner, (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).json({ error: "Sound not found." });
  const sound = loadDB().sounds.find((s) => s.id === req.params.id);
  const file = sound && path.join(SOUNDS_DIR, `${sound.id}.${sound.ext}`);
  if (!sound || !fs.existsSync(file)) return res.status(404).json({ error: "Sound not found." });
  res.set({ "Content-Type": sound.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=86400" });
  res.send(fs.readFileSync(file));
});
app.delete("/api/sounds/:id", requireOwner, (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).json({ error: "Sound not found." });
  const db = loadDB();
  const sound = db.sounds.find((s) => s.id === req.params.id);
  if (!sound) return res.status(404).json({ error: "Sound not found." });
  db.sounds = db.sounds.filter((s) => s.id !== sound.id);
  db.repSounds = db.repSounds.filter((r) => r.choice !== "custom:" + sound.id);   // a rep set to this sound goes back to the default
  saveDB(db);
  try { fs.unlinkSync(path.join(SOUNDS_DIR, `${sound.id}.${sound.ext}`)); } catch (e) { /* the record is gone; a missing file is fine */ }
  try { fs.unlinkSync(path.join(SOUNDS_DIR, `${sound.id}.tv.wav`)); } catch (e) { /* it may never have had a Roku copy */ }
  res.json({ ok: true });
});

// ---------- A sound for each rep ----------
// When a rep closes a deal, THEIR sound plays on the leaderboard instead of the screen's usual one. A rep is matched by name (ignoring capitals and extra
// spaces), so the same person at two locations is one rep. The choice is a built-in sound, or one of the owner's own uploaded sounds. Reps with
// nothing set ("default") use whatever each screen is set to.
const BUILTIN_SOUND_KEYS = ["chaching", "airhorn", "kazoo", "boing", "party", "duck"];   // must match the built-in sounds on the leaderboard (a test checks that they do)
const MAX_REP_SOUNDS = 200;
const repKey = (name) => String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const repDisplayName = (name) => String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
app.get("/api/rep-sounds", requireOwner, (req, res) => {
  res.json(loadDB().repSounds.map((r) => ({ key: r.key, name: r.name, choice: r.choice })));
});
app.put("/api/rep-sounds", requireOwner, (req, res) => {
  const { name, choice } = req.body || {};
  const display = repDisplayName(name), key = repKey(display);
  if (typeof name !== "string" || !key) return res.status(400).json({ error: "Choose a rep." });
  const db = loadDB();
  if (choice === "default" || choice === null || choice === "") {                    // back to "use the screen's choice"
    db.repSounds = db.repSounds.filter((r) => r.key !== key);
    saveDB(db);
    return res.json({ ok: true, key, choice: "default" });
  }
  const valid = typeof choice === "string" && (BUILTIN_SOUND_KEYS.includes(choice) || (/^custom:[a-f0-9]{16}$/.test(choice) && db.sounds.some((s) => s.id === choice.slice(7))));
  if (!valid) return res.status(400).json({ error: "That sound isn't available." });
  const existing = db.repSounds.find((r) => r.key === key);
  if (!existing && db.repSounds.length >= MAX_REP_SOUNDS) return res.status(400).json({ error: "That's too many reps with their own sound." });
  if (existing) { existing.name = display; existing.choice = choice; } else db.repSounds.push({ key, name: display, choice });
  saveDB(db);
  res.json({ ok: true, key, name: display, choice });
});

// =====================================================================================================================================
// ROKU TV APP
// A Roku can't show a web page, so the leaderboard is a small private Roku app instead. It shows the same ranking and the same "Deal closed"
// banners, and plays the same sounds. It asks the tracker for a TV-ONLY feed using a TV key; that key can read the leaderboard and fetch the
// sounds and can do NOTHING else, and the owner can turn it off at any time. "Download the Roku app" makes a fresh key and builds the app with
// that key already inside, so nothing has to be typed on the remote.
// =====================================================================================================================================
const zlib = require("zlib");
const ROKU_DIR = path.join(__dirname, "roku");
const TV_VOLUMES = { low: 40, medium: 70, high: 100 };
const TV_SOUND_METHODS = ["auto", "effects", "player"];   // how the Roku plays a sound: try both ways (auto), or only the sound-effects player, or only the audio player
let tvLastSeenAt = 0;                                      // when the TV last asked for the feed (kept in memory only: it is just "is the TV alive right now")
let tvReportTimes = [];
const sha256 = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
const hashInt = (x) => parseInt(sha256(x).slice(0, 8), 16);

function tvAuth(req, res, next) {
  const db = loadDB();
  const key = String(req.get("x-tv-key") || "");
  if (!db.tv.keyHash || !key) return res.status(401).json({ error: "Not allowed." });
  const a = Buffer.from(sha256(key)), b = Buffer.from(db.tv.keyHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Not allowed." });
  next();
}

// Which sound a deal gets on the TV, worked out here so the Roku only has to play it: the rep's own sound if they have one and it is ready for the Roku,
// otherwise the TV's default. "Random" is picked from the deal itself, so the same deal always gets the same sound. Off means silent for everyone.
function resolveTvSound(db, repName, closeKey) {
  const settings = db.tv.settings;
  if (settings.defaultSound === "off") return null;
  const readyCustom = db.sounds.filter((s) => s.tvWav).map((s) => s.id);
  const usable = (c) => typeof c === "string" && (BUILTIN_SOUND_KEYS.includes(c) || (c.indexOf("custom:") === 0 && readyCustom.includes(c.slice(7))));
  const rep = db.repSounds.find((r) => r.key === repKey(repName));
  let choice = rep && usable(rep.choice) ? rep.choice : settings.defaultSound;
  const fallback = BUILTIN_SOUND_KEYS[hashInt("fallback:" + closeKey) % BUILTIN_SOUND_KEYS.length];
  if (choice === "random") { const pool = BUILTIN_SOUND_KEYS.concat(readyCustom.map((id) => "custom:" + id)); choice = pool[hashInt(closeKey) % pool.length]; }
  else if (choice === "custom-random") choice = readyCustom.length ? "custom:" + readyCustom[hashInt(closeKey) % readyCustom.length] : fallback;
  if (BUILTIN_SOUND_KEYS.includes(choice)) return { kind: "builtin", key: choice };
  if (usable(choice)) return { kind: "custom", id: choice.slice(7), fallback };
  return { kind: "builtin", key: fallback };       // the choice isn't ready for the Roku (yet): a built-in sound, never silence
}
const easternDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);


// ---- what the TV's rep rows show besides the numbers: a badge (initials on a color), and progress toward the rep's goal ----
const REP_COLORS = ["0x3B82F6FF", "0x22C55EFF", "0xF59E0BFF", "0xA855F7FF", "0xEF4444FF", "0x14B8A6FF", "0xEC4899FF", "0x6366F1FF"];
const repColor = (name) => REP_COLORS[parseInt(sha256(repKey(name)).slice(0, 2), 16) % REP_COLORS.length];     // the same rep always gets the same color
const repInitials = (name) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0] + words[words.length - 1] : words[0]).toUpperCase();
};
// Goal progress exactly as the web screens work it out: closes and value count deals CLOSED in the week/month, commission counts real commission from cars
// that ARRIVED. A rep with a weekly goal shows that one; otherwise their monthly one. Remembered for a minute, so the TV never makes the shops work harder.
let tvGoalCache = { at: 0, key: "", data: {} };
async function tvGoalProgress(db) {
  const goals = (db.goals || []).filter((g) => g && g.repName && Number(g.target) > 0 && (g.cadence === "week" || g.cadence === "month"));
  if (!goals.length) return {};
  const today = easternDay(new Date());
  const key = JSON.stringify(goals.map((g) => [g.repName, g.metric, g.cadence, g.target])) + today;
  if (tvGoalCache.key === key && Date.now() - tvGoalCache.at < 60000) return tvGoalCache.data;
  try {
    const byCadence = {};
    await Promise.all(Array.from(new Set(goals.map((g) => g.cadence))).map(async (cad) => {
      const [c, a] = await Promise.all([buildCombinedStats(db, { period: cad, date: today, dateBasis: "closed" }), buildCombinedStats(db, { period: cad, date: today })]);
      byCadence[cad] = { closing: Object.fromEntries(c.perRep.map((r) => [r.name, r])), arrival: Object.fromEntries(a.perRep.map((r) => [r.name, r])) };
    }));
    const out = {};
    goals.slice().sort((x, y) => (x.cadence === "week" ? 0 : 1) - (y.cadence === "week" ? 0 : 1)).forEach((g) => {
      if (out[g.repName]) return;
      const s = byCadence[g.cadence], c = s.closing[g.repName], a = s.arrival[g.repName];
      const current = g.metric === "commission" ? (a ? a.actualCommission : 0) : g.metric === "value" ? (c ? c.closedValue : 0) : (c ? c.closeCount : 0);
      const isCount = g.metric === "closes", toUnits = (n) => (isCount ? Math.round(n) : Math.round((Number(n) || 0) * 100));
      out[g.repName] = { cadence: g.cadence, metric: g.metric, pct: Math.min(100, Math.round((current / g.target) * 100)), current: toUnits(current), target: toUnits(g.target) };
    });
    tvGoalCache = { at: Date.now(), key, data: out };
    return out;
  } catch (e) { return {}; }             // goals are a nice extra: if they can't be worked out, the leaderboard still shows
}

// Exactly what the web leaderboard shows: the same two questions (what each rep closed today; what actually arrived today), merged by rep name,
// ranked by value closed, then deals closed, then commission, then name. All money goes out as WHOLE CENTS: the TV's numbers are single-precision
// and would lose cents on larger amounts if decimals were used.
async function buildTvFeed(db) {
  const today = easternDay(new Date());
  const [closing, arrival] = await Promise.all([buildCombinedStats(db, { period: "day", date: today, dateBasis: "closed" }), buildCombinedStats(db, { period: "day", date: today })]);
  const byName = {};
  closing.perRep.forEach((r) => { byName[r.name] = byName[r.name] || {}; byName[r.name].closing = r; });
  arrival.perRep.forEach((r) => { byName[r.name] = byName[r.name] || {}; byName[r.name].arrival = r; });
  const merged = Object.entries(byName).map(([name, { closing: c, arrival: a }]) => ({ name, closeCount: c ? c.closeCount : 0, closedValue: c ? c.closedValue : 0, arrivedCount: a ? a.arrivedCount : 0, commission: a ? a.actualCommission : 0 }));
  merged.sort((x, y) => y.closedValue - x.closedValue || y.closeCount - x.closeCount || y.commission - x.commission || x.name.localeCompare(y.name));
  const cents = (n) => Math.round((Number(n) || 0) * 100);
  const goals = await tvGoalProgress(db);
  const photoOf = (name) => { const p = (db.repPhotos || []).find((x) => x.key === repKey(name)); return p ? { id: p.id } : null; };
  const rows = merged.map((r, i) => ({ rank: i + 1, name: r.name, initials: repInitials(r.name), color: repColor(r.name), photo: photoOf(r.name), closedCents: cents(r.closedValue), closeCount: r.closeCount, arrivedCount: r.arrivedCount, commissionCents: cents(r.commission), goal: goals[r.name] || null }));
  const totals = { closedCents: rows.reduce((a, r) => a + r.closedCents, 0), closeCount: rows.reduce((a, r) => a + r.closeCount, 0), arrivedCount: rows.reduce((a, r) => a + r.arrivedCount, 0), commissionCents: rows.reduce((a, r) => a + r.commissionCents, 0) };
  const now = Date.now();
  const closes = closing.perRep.flatMap((r) => r.closes.map((c) => {
    const key = `${c.locationId}:${c.id}`, at = Date.parse(c.closedAt);
    return { key, repName: r.name, priceCents: cents(c.basePrice), service: c.baseService || c.car || "", location: c.locationName || "", ageSec: Number.isFinite(at) ? Math.round((now - at) / 1000) : null, sound: resolveTvSound(db, r.name, key) };
  }));
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(now)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const settings = db.tv.settings, ready = db.sounds.filter((s) => s.tvWav).map((s) => s.id), need = new Set();
  if (settings.defaultSound === "random" || settings.defaultSound === "custom-random") ready.forEach((id) => need.add(id));
  else if (typeof settings.defaultSound === "string" && settings.defaultSound.indexOf("custom:") === 0 && ready.includes(settings.defaultSound.slice(7))) need.add(settings.defaultSound.slice(7));
  db.repSounds.forEach((r) => { if (r.choice.indexOf("custom:") === 0 && ready.includes(r.choice.slice(7))) need.add(r.choice.slice(7)); });
  return { now: new Date(now).toISOString(), clock: { h: parts.hour || 0, m: parts.minute || 0, s: parts.second || 0 }, volume: TV_VOLUMES[settings.volume] || 70, soundMethod: settings.soundMethod || "auto", confetti: settings.confetti !== false, totals, test: { seq: db.tv.test.seq || 0, sound: db.tv.test.sound }, rows, closes, customSounds: Array.from(need), unreachable: Array.from(new Set([...closing.errors, ...arrival.errors].map((e) => e.locationName))) };
}
app.get("/api/tv/feed", tvAuth, async (req, res) => {
  tvLastSeenAt = Date.now();
  try { res.set("Cache-Control", "no-store"); res.json(await buildTvFeed(loadDB())); } catch (e) { res.status(500).json({ error: "Couldn't build the feed." }); }
});
app.get("/api/tv/sound/:id", tvAuth, (req, res) => {
  const sound = /^[a-f0-9]{16}$/.test(req.params.id) ? loadDB().sounds.find((s) => s.id === req.params.id && s.tvWav) : null;
  const file = sound && path.join(SOUNDS_DIR, `${sound.id}.tv.wav`);
  if (!sound || !fs.existsSync(file)) return res.status(404).json({ error: "Sound not found." });
  res.set({ "Content-Type": "audio/wav", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.send(fs.readFileSync(file));
});

// ---- the owner's side: status, settings, building the app, turning it off ----
app.get("/api/tv", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ hasKey: !!db.tv.keyHash, createdAt: db.tv.createdAt, settings: db.tv.settings, lastSeenAt: tvLastSeenAt ? new Date(tvLastSeenAt).toISOString() : null, reports: db.tv.reports.slice(-12).reverse() });
});
app.put("/api/tv/settings", requireOwner, (req, res) => {
  const db = loadDB();
  const { defaultSound, volume, soundMethod, confetti } = req.body || {};
  const ready = db.sounds.filter((s) => s.tvWav).map((s) => s.id);
  const okSound = defaultSound === undefined || defaultSound === "random" || defaultSound === "off" || defaultSound === "custom-random" || BUILTIN_SOUND_KEYS.includes(defaultSound) || (typeof defaultSound === "string" && /^custom:[a-f0-9]{16}$/.test(defaultSound) && ready.includes(defaultSound.slice(7)));
  if (!okSound) return res.status(400).json({ error: "That sound isn't available on the Roku yet." });
  if (volume !== undefined && !TV_VOLUMES[volume]) return res.status(400).json({ error: "Volume must be low, medium or high." });
  if (soundMethod !== undefined && !TV_SOUND_METHODS.includes(soundMethod)) return res.status(400).json({ error: "Unknown way of playing sounds." });
  if (confetti !== undefined && typeof confetti !== "boolean") return res.status(400).json({ error: "Confetti must be on or off." });
  if (confetti !== undefined) db.tv.settings.confetti = confetti;
  if (soundMethod !== undefined) db.tv.settings.soundMethod = soundMethod;
  if (defaultSound !== undefined) db.tv.settings.defaultSound = defaultSound;
  if (volume !== undefined) db.tv.settings.volume = volume;
  saveDB(db);
  res.json({ ok: true, settings: db.tv.settings });
});

// The Roku tells the tracker what it is doing (its model, which sound it tried and whether that worked), so a silent TV can be diagnosed from here
// instead of guessed at. Only the last 40 are kept, and anything odd in the text is stripped.
app.post("/api/tv/report", tvAuth, (req, res) => {
  const b = req.body || {};
  const clean = (x, n) => String(x === undefined || x === null ? "" : x).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const event = clean(b.event, 40), detail = clean(b.detail, 300);
  if (!event) return res.status(400).json({ error: "Missing event." });
  const now = Date.now();
  tvReportTimes = tvReportTimes.filter((t) => now - t < 60000);
  if (tvReportTimes.length >= 40) return res.status(429).json({ error: "Too many reports." });
  tvReportTimes.push(now);
  const db = loadDB();
  db.tv.reports.push({ at: new Date(now).toISOString(), event, detail });
  if (db.tv.reports.length > 40) db.tv.reports = db.tv.reports.slice(-40);
  saveDB(db);
  res.json({ ok: true });
});
// "Play a test sound on the TV": the TV notices on its next refresh and plays it, so the owner can test without waiting for a deal.
app.post("/api/tv/test-sound", requireOwner, (req, res) => {
  const db = loadDB();
  const key = (req.body && req.body.key) || "chaching";
  const readyCustom = db.sounds.filter((x) => x.tvWav).map((x) => x.id);
  const isCustom = typeof key === "string" && /^custom:[a-f0-9]{16}$/.test(key) && readyCustom.includes(key.slice(7));
  if (!(typeof key === "string" && BUILTIN_SOUND_KEYS.includes(key)) && !isCustom) return res.status(400).json({ error: "That sound isn't available on the Roku." });
  db.tv.test = { seq: (db.tv.test.seq || 0) + 1, sound: isCustom ? { kind: "custom", id: key.slice(7), fallback: "chaching" } : { kind: "builtin", key } };
  saveDB(db);
  res.json({ ok: true, seq: db.tv.test.seq });
});
app.delete("/api/tv/key", requireOwner, (req, res) => {
  const db = loadDB();
  db.tv.keyHash = null; db.tv.createdAt = null;
  saveDB(db);
  res.json({ ok: true });
});

// A .zip with no extra libraries (the format is simple enough to write by hand).
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  files.forEach((f) => {
    const name = Buffer.from(f.name, "utf8"), raw = f.data, packed = zlib.deflateRawSync(raw), useDeflate = !f.store && packed.length < raw.length, body = useDeflate ? packed : raw, method = useDeflate ? 8 : 0, crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5a21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x5a21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  });
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
function rokuFiles(dir, prefix) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".") || e.name === "bsconfig.json" || e.name === "config.json") return [];
    return e.isDirectory() ? rokuFiles(path.join(dir, e.name), prefix + e.name + "/") : [{ name: prefix + e.name, data: fs.readFileSync(path.join(dir, e.name)) }];
  });
}
// Builds the app with a BRAND NEW key inside (any app made before this stops working, which is also how an old copy is cancelled).
app.post("/api/tv/package", requireOwner, (req, res) => {
  const db = loadDB();
  const key = crypto.randomBytes(24).toString("hex");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim(), host = req.get("host");
  const config = Buffer.from(JSON.stringify({ server: `${proto}://${host}`, key }, null, 2));
  const files = rokuFiles(ROKU_DIR, "");
  files.sort((x, y) => (x.name === "manifest" ? -1 : y.name === "manifest" ? 1 : x.name < y.name ? -1 : 1));
  files.push({ name: "config.json", data: config });
  // The sounds go in UNCOMPRESSED (the Roku reads them straight out of the package), and the app gets a list of what each sound file should be (its size and checksums), so on the TV it can check every file and report if one is damaged.
  const check = {};
  files.filter((f) => /^sounds\/[a-z]+\.wav$/.test(f.name)).forEach((f) => {
    f.store = true;
    let sum16 = 0, head = 0;                                   // the total of every 16th byte (enough to catch scrambled or shifted data without making a TV add up every byte) and of the 44-byte header
    for (let i = 0; i < f.data.length; i += 16) sum16 += f.data[i];
    for (let i = 0; i < 44 && i < f.data.length; i++) head += f.data[i];
    check[f.name.slice(7, -4)] = { size: f.data.length, sum16, head };
  });
  files.push({ name: "sounds/check.json", data: Buffer.from(JSON.stringify(check)) });
  db.tv.keyHash = sha256(key); db.tv.createdAt = new Date().toISOString();
  saveDB(db);
  res.set({ "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="SBN-Leaderboard-Roku.zip"', "Cache-Control": "no-store" });
  res.send(makeZip(files));
});

// The owner's own sounds, as a Roku-friendly copy: a 16-bit mono WAV. The browser makes it (it can read any audio format and match the loudness)
// and sends it here; the original upload is left alone.
function checkTvWav(b) {
  if (!Buffer.isBuffer(b) || b.length < 44 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return { error: "That isn't a WAV file." };
  let pos = 12, fmt = null, dataLen = null;
  while (pos + 8 <= b.length) {
    const id = b.toString("latin1", pos, pos + 4), len = b.readUInt32LE(pos + 4);
    if (id === "fmt " && pos + 8 + 16 <= b.length) fmt = { format: b.readUInt16LE(pos + 8), channels: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    if (id === "data") { dataLen = Math.min(len, b.length - pos - 8); break; }
    pos += 8 + len + (len % 2);
  }
  if (!fmt || dataLen === null) return { error: "That WAV file is incomplete." };
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate < 8000 || fmt.rate > 48000) return { error: "The Roku copy must be a 16-bit mono WAV." };
  const seconds = dataLen / (fmt.rate * 2);
  if (seconds < 0.05) return { error: "That sound is too short." };
  if (seconds > 13) return { error: "That sound is too long for the Roku (the limit is about 12 seconds)." };
  return { seconds };
}
app.put("/api/sounds/:id/tv-wav", requireOwner, express.raw({ type: () => true, limit: MAX_SOUND_BYTES }), (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).json({ error: "Sound not found." });
  const db = loadDB();
  const sound = db.sounds.find((s) => s.id === req.params.id);
  if (!sound) return res.status(404).json({ error: "Sound not found." });
  const check = checkTvWav(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  try { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); fs.writeFileSync(path.join(SOUNDS_DIR, `${sound.id}.tv.wav`), req.body); } catch (e) { return res.status(500).json({ error: "Couldn't save that on the server." }); }
  sound.tvWav = true;
  saveDB(db);
  res.json({ ok: true, seconds: Math.round(check.seconds * 100) / 100 });
});

// =====================================================================================================================================
// REP PHOTOS
// A picture for each rep, shown in the circle next to their name on the Roku (instead of their initials). The Settings screen crops it into a circle
// and shrinks it to a small PNG before sending it, so what arrives here is always tiny. A photo is personal, so only the owner and the TV's key can
// fetch it, and every upload is checked to be a genuine, intact PNG of a sensible size. A rep is matched by name, like their sound.
// =====================================================================================================================================
const PHOTOS_DIR = path.join(DATA_DIR, "repphotos");
const MAX_PHOTO_BYTES = 300 * 1024, MAX_REP_PHOTOS = 100;
function checkPhotoPng(b) {
  if (!Buffer.isBuffer(b) || b.length < 70) return { error: "That isn't a picture file." };
  if (b.toString("hex", 0, 8) !== "89504e470d0a1a0a") return { error: "That isn't a PNG picture." };
  let pos = 8, width = 0, height = 0, sawIdat = false, sawEnd = false, first = true;
  while (pos + 12 <= b.length && !sawEnd) {
    const len = b.readUInt32BE(pos), type = b.toString("latin1", pos + 4, pos + 8);
    if (len > b.length || pos + 12 + len > b.length) return { error: "That picture is cut short or damaged." };
    if (b.readUInt32BE(pos + 8 + len) !== crc32(b.subarray(pos + 4, pos + 8 + len))) return { error: "That picture is damaged." };
    if (first) { if (type !== "IHDR" || len !== 13) return { error: "That picture is damaged." }; width = b.readUInt32BE(pos + 8); height = b.readUInt32BE(pos + 12); first = false; }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") sawEnd = true;
    pos += 12 + len;
  }
  if (!sawIdat || !sawEnd || pos !== b.length) return { error: "That picture is cut short or damaged." };
  if (width !== height || width < 64 || width > 512) return { error: "The picture must be square, between 64 and 512 pixels." };
  return { width };
}
const photoFile = (id) => path.join(PHOTOS_DIR, `${id}.png`);
app.get("/api/rep-photos", requireOwner, (req, res) => {
  res.json(loadDB().repPhotos.map((p) => ({ key: p.key, name: p.name, id: p.id, at: p.at })));
});
app.get("/api/rep-photos/:id", requireOwner, (req, res) => {
  const ok = /^[a-f0-9]{16}$/.test(req.params.id) && loadDB().repPhotos.some((p) => p.id === req.params.id) && fs.existsSync(photoFile(req.params.id));
  if (!ok) return res.status(404).json({ error: "Photo not found." });
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" });
  res.send(fs.readFileSync(photoFile(req.params.id)));
});
app.put("/api/rep-photos", requireOwner, express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), (req, res) => {
  const display = repDisplayName(req.query.name), key = repKey(display);
  if (!key) return res.status(400).json({ error: "Choose a rep." });
  const check = checkPhotoPng(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  const db = loadDB();
  const existing = db.repPhotos.find((p) => p.key === key);
  if (!existing && db.repPhotos.length >= MAX_REP_PHOTOS) return res.status(400).json({ error: "That's too many reps with photos." });
  const id = crypto.randomBytes(8).toString("hex");
  try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); fs.writeFileSync(photoFile(id), req.body); } catch (e) { return res.status(500).json({ error: "Couldn't save that on the server." }); }
  if (existing) { try { fs.unlinkSync(photoFile(existing.id)); } catch (e) { /* already gone */ } existing.id = id; existing.name = display; existing.at = new Date().toISOString(); }
  else db.repPhotos.push({ key, name: display, id, at: new Date().toISOString() });
  saveDB(db);
  res.json({ ok: true, id });
});
app.delete("/api/rep-photos", requireOwner, (req, res) => {
  const key = repKey(repDisplayName(req.query.name));
  const db = loadDB(), existing = db.repPhotos.find((p) => p.key === key);
  if (existing) { try { fs.unlinkSync(photoFile(existing.id)); } catch (e) { /* already gone */ } db.repPhotos = db.repPhotos.filter((p) => p.key !== key); saveDB(db); }
  res.json({ ok: true });
});
// the TV fetches a rep's photo with its key
app.get("/api/tv/photo/:id", tvAuth, (req, res) => {
  const ok = /^[a-f0-9]{16}$/.test(req.params.id) && loadDB().repPhotos.some((p) => p.id === req.params.id) && fs.existsSync(photoFile(req.params.id));
  if (!ok) return res.status(404).json({ error: "Photo not found." });
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.send(fs.readFileSync(photoFile(req.params.id)));
});

// A file over the size limit gets a plain-English answer instead of an error page.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large" && req.path.indexOf("/api/sounds") === 0) return res.status(413).json({ error: "That file is too big. Keep it under 3 MB." });
  if (err && err.type === "entity.too.large" && req.path.indexOf("/api/rep-photos") === 0) return res.status(413).json({ error: "That picture is too big (the limit is 300 KB; the screen shrinks pictures for you, so this is unexpected)." });
  next(err);
});

app.listen(PORT, () => console.log(`Combined rep tracker running on port ${PORT}`));
