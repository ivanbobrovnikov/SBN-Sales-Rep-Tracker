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
  if (db.ownerPasswordHash === undefined) db.ownerPasswordHash = OWNER_PASSWORD_HASH_ENV || null;
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

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

app.get("/api/combined/salesrep-stats", requireOwner, async (req, res) => {
  const db = loadDB();
  const qs = periodQueryString(req.query);
  const results = [];
  const errors = [];
  await Promise.all(db.locations.map(async (loc) => {
    try {
      const data = await fetchLocationCloses(loc, qs);
      results.push({ locationId: loc.id, locationName: loc.name, perRep: data.perRep || [] });
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

  res.json({ perRep, errors, locationsQueried: results.map((r) => r.locationName) });
});

// ---------- Combined Cleanup ----------
app.get("/api/combined/cleanup-list", requireOwner, async (req, res) => {
  const db = loadDB();
  const all = [];
  const errors = [];
  await Promise.all(db.locations.map(async (loc) => {
    try {
      const r = await fetch(`${loc.url}/api/cross-location/cleanup-list?secret=${encodeURIComponent(loc.secret)}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      (data.jobs || []).forEach((j) => all.push({ ...j, locationId: loc.id, locationName: loc.name }));
    } catch (e) {
      errors.push({ locationName: loc.name, error: e.message || "Unreachable" });
    }
  }));
  res.json({ jobs: all.sort((a, b) => (a.date < b.date ? 1 : -1)), errors });
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

app.listen(PORT, () => console.log(`Combined rep tracker running on port ${PORT}`));
