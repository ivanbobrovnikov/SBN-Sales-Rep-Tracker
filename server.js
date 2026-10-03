require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.json");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
// Separate from WEBHOOK_SECRET - protects the read/write endpoints the combined sales rep
// tracker app uses to pull stats and push Cleanup fixes. Never used by GHL at all.
const CROSS_LOCATION_SECRET = process.env.CROSS_LOCATION_SECRET || "change-me-cross-location";

const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-too";
// This same codebase runs as multiple separate deployments, one per shop location — this
// is the one thing that should differ between them without touching any code. Defaults to
// West Berlin so the existing NJ deployment keeps working exactly as-is if this is never set.
const SHOP_LOCATION_LABEL = process.env.SHOP_LOCATION_LABEL || "West Berlin, NJ";

// ---------- tiny JSON "database" ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { employees: [], managers: [], salesReps: [], sales: [], attendance: [], auditLog: [], cashEntries: [], calendarServiceMap: {}, ownerPinHash: null };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (!db.managers) db.managers = [];
  if (!db.salesReps) db.salesReps = [];
  if (!db.attendance) db.attendance = [];
  if (!db.auditLog) db.auditLog = [];
  if (!db.cashEntries) db.cashEntries = [];
  if (!db.calendarServiceMap) db.calendarServiceMap = {};
  if (!db.tips) db.tips = [];
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function hash(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}
function newId() {
  return crypto.randomBytes(8).toString("hex");
}
// Records who changed a price, service, or sales rep assignment, and when — the actual
// answer to "who changed this and why does the number look different now."
function logAudit(db, req, sale, field, oldValue, newValue) {
  if (oldValue === newValue) return; // no real change, nothing to log
  if (!db.auditLog) db.auditLog = [];
  let actor = "Unknown";
  if (req.auth.role === "owner") actor = "Owner";
  else if (req.auth.role === "manager") {
    const mgr = (db.managers || []).find((m) => m.id === req.auth.id);
    actor = `${mgr ? mgr.name : "Removed manager"} (manager)`;
  }
  db.auditLog.unshift({
    id: newId(), timestamp: new Date().toISOString(), actor,
    saleId: sale.id, car: sale.car, field, oldValue: oldValue === undefined ? null : oldValue, newValue,
  });
  db.auditLog = db.auditLog.slice(0, 1000); // cap size so this can't grow forever
}
// A permanent safeguard, not a separate tool to remember to run — this flags every sale
// that shares a real customer with another active sale, right where commission actually
// gets calculated. Matches by contactId when both have one (strongest signal); falls back
// to same customer name + same calendar day when contactId is missing.
function findDuplicateSaleIds(sales) {
  const flagged = new Set();
  const normalize = (s) => String(s || "").trim().toLowerCase();
  const byContact = {};
  const byNameDay = {};
  sales.forEach((s) => {
    if (s.contactId) (byContact[s.contactId] = byContact[s.contactId] || []).push(s);
    else if (s.customerName && s.date) {
      const key = `${s.customerName.trim().toLowerCase()}|${s.date.slice(0, 10)}`;
      (byNameDay[key] = byNameDay[key] || []).push(s);
    }
  });
  // Grouping by customer alone isn't safe — the same person can genuinely book more than
  // one car. Within each customer's group, only flag the ones that ALSO share the same
  // car/title text as an actual duplicate; a second, different car is a real separate job.
  function flagRealDuplicatesWithin(group) {
    const byCar = {};
    group.forEach((s) => { (byCar[normalize(s.car)] = byCar[normalize(s.car)] || []).push(s); });
    Object.values(byCar).forEach((carGroup) => { if (carGroup.length > 1) carGroup.forEach((s) => flagged.add(s.id)); });
  }
  Object.values(byContact).forEach(flagRealDuplicatesWithin);
  Object.values(byNameDay).forEach(flagRealDuplicatesWithin);
  return flagged;
}
function monthKey(dateStr) {
  return (dateStr || "").slice(0, 7);
}
// Business hours: Mon–Sat, 8am–6pm, Eastern time — regardless of what timezone the server
// itself runs in. This decides which of a sales rep's two commission rates applies, based
// on the moment the deal actually closed (opportunity hit Booked w/ Deposit), not the
// scheduled appointment time. Sundays are ALWAYS after-hours, all day, regardless of time.
function isDuringBusinessHours(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return true; // safest default if something's malformed — don't silently overpay
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false, weekday: "short",
  }).formatToParts(d);
  const weekday = (parts.find((p) => p.type === "weekday") || {}).value;
  let hour = parseInt((parts.find((p) => p.type === "hour") || {}).value, 10);
  if (hour === 24) hour = 0; // some ICU builds report midnight as "24" instead of "00"
  const openDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // closed Sunday
  return openDays.includes(weekday) && hour >= 8 && hour < 18;
}

// True start/end of a calendar day in Eastern time, converted to the correct UTC instant.
// Every period boundary in this app needs this — using UTC midnight instead (the old way)
// meant "end of day" was actually landing around 8pm Eastern, silently excluding anything
// that happened later that same real day.
function startOfDayEastern(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return easternWallClockToUTC(y, m - 1, d, 0, 0, 0).toISOString();
}
function endOfDayEastern(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const nextDayMidnight = easternWallClockToUTC(y, m - 1, d + 1, 0, 0, 0);
  return new Date(nextDayMidnight.getTime() - 1).toISOString();
}

function dateRangeFor(query) {
  const period = query.period || "month";
  const ref = query.date ? new Date(query.date) : new Date();
  let start, end;
  if (period === "custom") {
    // A genuinely arbitrary owner-picked range - any start date through any end date,
    // inclusive of both, same Eastern-day boundaries as every other period here.
    const startDateStr = query.startDate || new Date().toISOString().slice(0, 10);
    const endDateStr = query.endDate || startDateStr;
    start = startOfDayEastern(startDateStr);
    end = endOfDayEastern(endDateStr);
  } else if (period === "day") {
    const d = query.date || new Date().toISOString().slice(0, 10);
    start = startOfDayEastern(d);
    end = endOfDayEastern(d);
  } else if (period === "week") {
    const day = ref.getUTCDay(); // 0=Sun
    const monday = new Date(ref);
    monday.setUTCDate(ref.getUTCDate() - ((day + 6) % 7));
    const mondayStr = monday.toISOString().slice(0, 10);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const sundayStr = sunday.toISOString().slice(0, 10);
    start = startOfDayEastern(mondayStr);
    end = endOfDayEastern(sundayStr);
  } else if (period === "payperiod") {
    // Real payroll schedule: a true 14-calendar-day span, non-overlapping with adjacent
    // periods — e.g. Aug 26 through Sept 8 when Sept 8 is the payroll-processing date you
    // pick, with the very next period picking up Sept 9, not re-claiming Sept 8.
    const endDateStr = query.date || new Date().toISOString().slice(0, 10);
    const endRef = new Date(endDateStr + "T12:00:00Z"); // noon avoids any day-boundary ambiguity
    const startRef = new Date(endRef);
    startRef.setUTCDate(startRef.getUTCDate() - 13);
    start = startOfDayEastern(startRef.toISOString().slice(0, 10));
    end = endOfDayEastern(endDateStr);
  } else if (period === "year") {
    const y = query.date ? query.date.slice(0, 4) : String(ref.getUTCFullYear());
    start = startOfDayEastern(`${y}-01-01`);
    end = endOfDayEastern(`${y}-12-31`);
  } else {
    // month
    const m = query.month || new Date().toISOString().slice(0, 7);
    const [y, mo] = m.split("-").map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    start = startOfDayEastern(`${m}-01`);
    end = endOfDayEastern(`${m}-${String(lastDay).padStart(2, "0")}`);
  }
  return { start, end };
}
function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  return dateStr >= start && dateStr <= end;
}
function saleUpsellTotal(sale) {
  return (sale.upsells || []).reduce((a, u) => a + (parseFloat(u.price) || 0), 0);
}
function saleTotal(sale) {
  return (parseFloat(sale.basePrice) || 0) + saleUpsellTotal(sale);
}
function money2(n) {
  return (Math.round((n || 0) * 100) / 100).toFixed(2);
}
// A cancelled job should never count toward revenue, commission, or "cars serviced" —
// but it should still be VISIBLE everywhere (All jobs, Job status, Search) so nobody
// wonders where it went. This is the one shared filter that keeps that rule consistent.
function excludingCancelled(sales) {
  return sales.filter((s) => s.status !== "cancelled");
}
// A job dated before the owner's chosen revenue-tracking start date is excluded from
// every revenue/commission total, everywhere — but its real price is never touched, and
// it still shows up completely normally in All Jobs, Search, and the schedule.
function afterRevenueStart(sale, db) {
  if (!db.revenueStartDate) return true;
  return (sale.date || "") >= db.revenueStartDate;
}
// The one combined filter used everywhere a dollar total gets calculated.
function revenueEligible(sales, db) {
  return excludingCancelled(sales).filter((s) => afterRevenueStart(s, db));
}

// Converts a wall-clock date/time that's known to represent Eastern time into the correct
// real UTC instant — accounting for daylight saving automatically, without any external
// timezone library.
function easternWallClockToUTC(y, mo, d, h, mi, s) {
  const guessUTC = Date.UTC(y, mo, d, h, mi, s);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guessUTC));
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  let hh = parseInt(map.hour, 10);
  if (hh === 24) hh = 0;
  const asIfEasternWereUTC = Date.UTC(+map.year, +map.month - 1, +map.day, hh, +map.minute, +map.second);
  const offset = asIfEasternWereUTC - guessUTC;
  return new Date(guessUTC - offset);
}

// GHL can send the appointment date as a human-readable string like "Thursday, August 20,
// 2026 12:00 AM" with NO timezone marker at all. That string is Eastern wall-clock time —
// but naively parsing it assumes the SERVER's own clock (UTC on Railway), which silently
// produces a time several hours off. This detects that case and converts it correctly.
// If the incoming string already has an explicit "Z" or "+HH:MM" offset, it's unambiguous
// and gets trusted as-is.
function normalizeDate(input) {
  if (!input) return null;
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(String(input).trim());

  // GHL's own API (used by the bulk import) sends dates like "2026-09-03 09:00:00" — no
  // timezone marker, and not the same shape as the human-readable format below. Without
  // this, a real 9am Eastern appointment gets treated as 9am UTC and displays as 5am
  // Eastern — exactly the bug this catches. Seconds are optional here too, since a
  // datetime-local input field (used for manual date/time correction) never includes them.
  const plainFormat = !hasExplicitOffset && String(input).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (plainFormat) {
    const d = easternWallClockToUTC(parseInt(plainFormat[1], 10), parseInt(plainFormat[2], 10) - 1, parseInt(plainFormat[3], 10), parseInt(plainFormat[4], 10), parseInt(plainFormat[5], 10), parseInt(plainFormat[6] || "0", 10));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const humanFormat = String(input).match(/(\w+),?\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!hasExplicitOffset && humanFormat) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const mo = months.indexOf(humanFormat[2].toLowerCase());
    if (mo !== -1) {
      const day = parseInt(humanFormat[3], 10);
      const year = parseInt(humanFormat[4], 10);
      let hour = parseInt(humanFormat[5], 10);
      const minute = parseInt(humanFormat[6], 10);
      const ampm = humanFormat[7];
      if (ampm) {
        if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
        if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
      }
      const d = easternWallClockToUTC(year, mo, day, hour, minute, 0);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// GHL doesn't send our custom fields at the top level of the webhook body — it nests them
// inside a "customData" object alongside a large amount of its own native payload data
// (contact info, workflow info, calendar info, etc). This unwraps that, with a fallback
// to the raw body for our own internal test-tool calls, which send flat JSON directly.
function ghlPayload(body) {
  if (body && body.customData && typeof body.customData === "object") return body.customData;
  return body || {};
}

// One shared rule for figuring out what a "Booked By" / sales rep name actually means,
// used identically whether it arrives via the initial booking webhook or the later sync.
// A real registered sales rep name = normal commission attribution. Anything else — a
// manager, a tech, the owner personally, or just an unrecognized name — is a walk-in.
// It's never treated as an error; if it happens to match a specific manager or tech,
// they're pre-filled as the closer, otherwise it's left for a human to assign.
// Appointment titles at this shop start with the closer's initials, e.g. "DG 2024 Toyota
// Venza Ceramic Coating 499-95depo" — this pulls that leading token off and matches it
// against registered sales reps. This turned out to be more reliable than GHL's own
// "Contact Owner" field, which reflects generic account ownership, not who actually closed
// the specific deal.
// Appointment titles at this shop include the closer's initials somewhere — usually but
// not always at the start (e.g. "DG 2024 Toyota Venza Ceramic Coating 499-95depo"). This
// scans every all-caps 2-4 letter token in the title and returns the first one that
// matches a registered sales rep. This turned out to be more reliable than GHL's own
// "Contact Owner" field, which reflects generic account ownership, not who actually closed
// the specific deal.
// Known limitation, worth remembering: a car trim abbreviation (GT, RS, SS, etc.) could in
// theory collide with a rep's initials. Not a problem with the current three reps' initials
// (DG, FK, TG), but worth a second look if a future rep's initials match a common trim name.
function repFromTitleInitials(db, title) {
  if (!title) return null;
  const tokens = String(title).toUpperCase().match(/[A-Z]{2,4}/g) || [];
  for (const token of tokens) {
    const rep = db.salesReps.find((r) => r.initials && r.initials.toUpperCase() === token);
    if (rep) return rep;
  }
  return null;
}

function resolveSalesRepAttribution(db, salesRepName, appointmentTitle) {
  // Title initials are the trusted source now — proven more reliable than GHL's own
  // "Contact Owner" field, which reflects generic account ownership rather than who
  // actually closed this specific deal. Checked first, regardless of what else was sent.
  const titleRep = repFromTitleInitials(db, appointmentTitle);
  if (titleRep) return { salesRepId: titleRep.id, salesRepName: titleRep.name, isWalkIn: false };

  if (!salesRepName) return null;
  const nameLower = String(salesRepName).trim().toLowerCase();
  const rep = db.salesReps.find((r) => r.name.toLowerCase() === nameLower);
  if (rep) return { salesRepId: rep.id, salesRepName: rep.name, isWalkIn: false };
  const staffManager = db.managers.find((m) => m.name.toLowerCase() === nameLower);
  const staffEmployee = !staffManager && db.employees.find((e) => e.name.toLowerCase() === nameLower);
  const result = { salesRepId: null, salesRepName: "Walk-in (needs closer assigned)", isWalkIn: true };
  if (staffManager || staffEmployee) {
    result.walkInClosedByType = staffManager ? "manager" : "employee";
    result.walkInClosedById = staffManager ? staffManager.id : staffEmployee.id;
    result.walkInClosedByName = staffManager ? staffManager.name : staffEmployee.name;
  }
  return result;
}

function upsertSaleFromGHL(db, { date, customerName, customerPhone, customerEmail, contactId, car, employeeName, salesRepName, baseService, basePrice, ghlOpportunityId, closedAt, calendarId }) {
  // employeeName can be a single tech or several, e.g. "Jordan Smith, Sam Rivera" —
  // this is how tag-teamed jobs (multiple techs on one car) get represented.
  const rawNames = String(employeeName || "").split(/[,&]/).map((n) => n.trim()).filter(Boolean);
  const matched = [];
  const unmatched = [];
  rawNames.forEach((n) => {
    const emp = db.employees.find((e) => e.name.toLowerCase() === n.toLowerCase());
    if (emp) matched.push(emp);
    else if (n) unmatched.push(n);
  });
  const attribution = resolveSalesRepAttribution(db, salesRepName, car);
  let sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  let isNew = !sale;
  if (!sale && contactId) {
    // A reschedule in GHL can generate a brand-new Appointment ID for what is logically the
    // same booking — matching strictly by that ID would treat it as an unrelated new job.
    // But the same customer can genuinely book more than one car at once, so matching by
    // contact alone isn't safe — that could silently merge two real, separate jobs into
    // one, which is worse than a duplicate since one of them would just vanish. Requiring
    // the car/title text to substantially match is what actually distinguishes "this exact
    // booking got rescheduled" from "this customer booked a second, different car" — a
    // substring check (not exact) tolerates GHL appending something like "- RESCHEDULED"
    // or otherwise lightly reformatting the title without losing the real vehicle text.
    const normalize = (s) => String(s || "").trim().toLowerCase();
    const carsLikelyMatch = (a, b) => {
      const na = normalize(a), nb = normalize(b);
      if (!na || !nb) return false;
      return na === nb || na.includes(nb) || nb.includes(na);
    };
    const existingUnresolved = db.sales.find((s) =>
      s.contactId === contactId && !["arrived", "no_show", "cancelled"].includes(s.status) && carsLikelyMatch(s.car, car)
    );
    if (existingUnresolved) {
      sale = existingUnresolved;
      isNew = false;
      const oldOppId = sale.ghlOpportunityId;
      sale.ghlOpportunityId = ghlOpportunityId; // future events for this booking now match directly
      if (oldOppId !== ghlOpportunityId) {
        if (!db.auditLog) db.auditLog = [];
        db.auditLog.unshift({
          id: newId(), timestamp: new Date().toISOString(), actor: "Auto-matched (reschedule)",
          saleId: sale.id, car: sale.car, field: "GHL Opportunity ID", oldValue: oldOppId, newValue: ghlOpportunityId,
        });
        db.auditLog = db.auditLog.slice(0, 1000);
      }
    }
  }
  if (!sale) {
    sale = { id: newId(), ghlOpportunityId, upsells: [], status: "pending", completed: false, paid: false };
    db.sales.push(sale);
  }
  // closedAt is stamped ONCE, at the exact moment the deal was actually closed (this webhook
  // firing for the first time = the opportunity hitting Booked w/ Deposit). Later syncs
  // (like a price update) never touch it — that would let someone accidentally shift a
  // rep's commission rate after the fact just by editing the price later.
  if (isNew) sale.closedAt = closedAt || new Date().toISOString();
  sale.date = normalizeDate(date) || sale.date || new Date().toISOString();
  sale.customerName = customerName || sale.customerName || "";
  sale.customerPhone = customerPhone || sale.customerPhone || "";
  sale.customerEmail = customerEmail || sale.customerEmail || "";
  sale.contactId = contactId || sale.contactId || null;
  sale.car = car || sale.car || "";
  sale.employeeIds = matched.map((e) => e.id);
  sale.employeeNames = matched.map((e) => e.name).concat(unmatched.map((n) => n + " (unmatched)")).join(", ") || "Unassigned";
  if (attribution) {
    sale.salesRepId = attribution.salesRepId; sale.salesRepName = attribution.salesRepName; sale.isWalkIn = attribution.isWalkIn;
    if (attribution.walkInClosedByType) {
      sale.walkInClosedByType = attribution.walkInClosedByType;
      sale.walkInClosedById = attribution.walkInClosedById;
      sale.walkInClosedByName = attribution.walkInClosedByName;
    }
  }
  else if (salesRepName) { sale.salesRepId = sale.salesRepId || null; sale.salesRepName = salesRepName + " (unmatched)"; }
  else { sale.salesRepId = sale.salesRepId || null; sale.salesRepName = sale.salesRepName || "Unassigned"; }
  sale.baseService = baseService || sale.baseService || "";
  sale.basePrice = basePrice !== undefined ? parseFloat(basePrice) || 0 : sale.basePrice || 0;
  sale.calendarId = calendarId || sale.calendarId || null;
  sale.syncedFromGHL = true;
  if (!sale.status) sale.status = "pending";
  if (sale.completed === undefined) sale.completed = false;
  if (sale.paid === undefined) sale.paid = false;
  return sale;
}

// Backward/forward-compatible accessor: some records may still use the old single employeeId shape.
function saleEmployeeIds(sale) {
  if (sale.employeeIds) return sale.employeeIds;
  return sale.employeeId ? [sale.employeeId] : [];
}
// Every upsell knows who personally sold it (employeeId OR managerId) — this resolves that
// into an actual display name so anyone looking at a job can see who upsold what.
function resolveUpsellNames(upsells, db) {
  return (upsells || []).map((u) => {
    let name = "Unassigned";
    if (u.employeeId) name = (db.employees.find((e) => e.id === u.employeeId) || {}).name || "Removed employee";
    else if (u.managerId) name = (db.managers.find((m) => m.id === u.managerId) || {}).name || "Removed manager";
    else if (u.salesRepId) name = `${u.salesRepName || "Removed rep"} (sales rep)`;
    return { ...u, attributedToName: name };
  });
}

// ---------- app setup ----------
const app = express();
app.disable("etag"); // this is what was actually causing 304 "not modified" responses on API calls
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // some webhook senders (possibly GHL) post form-encoded, not JSON
app.use(cookieParser());
// Every /api response is dynamic data — never let the browser cache it. Without this,
// a browser can silently serve a stale cached response (HTTP 304) for things like the
// debug log, dashboard numbers, or job status, making "refresh" appear to do nothing.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const AUTH_COOKIE = "sbn_auth";
const AUTH_MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year — stays logged in on a phone indefinitely

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}
function signAuth(payload) {
  const data = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const sig = toBase64Url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
  return `${data}.${sig}`;
}
function verifyAuth(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = toBase64Url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
  if (sig !== expected) return null;
  try { return JSON.parse(fromBase64Url(data).toString()); } catch (e) { return null; }
}
function setAuthCookie(res, payload) {
  res.cookie(AUTH_COOKIE, signAuth(payload), { maxAge: AUTH_MAX_AGE, httpOnly: true, sameSite: "lax" });
}

// Every request gets req.auth populated from the signed cookie — no server-side session
// store involved, so logins survive server restarts and redeploys.
app.use((req, res, next) => {
  req.auth = verifyAuth(req.cookies[AUTH_COOKIE]) || { role: null };
  next();
});

// Before/after documentation — one walk-around clip per stage instead of a dozen separate
// stills. Accepts either video or a photo in that same slot, since not every phone/network
// makes video easy in the moment.
const PHOTO_SLOTS = ["walkaround"];
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".mp4";
    cb(null, `${req.params.saleId}-${req.body.stage}-${req.body.slot}-${newId()}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB - a real walk-around video needs real room
  fileFilter: (req, file, cb) => {
    if (!/^image\/|^video\//.test(file.mimetype)) return cb(new Error("Only image or video files are allowed."));
    cb(null, true);
  },
});

app.post("/api/sales/:saleId/photos", requireEmployee, photoUpload.single("photo"), (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { stage, slot } = req.body;
  if (!["before", "after"].includes(stage)) return res.status(400).json({ error: "stage must be 'before' or 'after'." });
  if (!PHOTO_SLOTS.includes(slot)) return res.status(400).json({ error: "Invalid photo slot." });
  if (!req.file) return res.status(400).json({ error: "No photo file received." });

  if (!sale.photos) sale.photos = { before: {}, after: {} };
  if (!sale.photos[stage]) sale.photos[stage] = {};
  // Replacing an existing photo in this slot — delete the old file so they don't pile up.
  const existing = sale.photos[stage][slot];
  if (existing) {
    const oldPath = path.join(PHOTOS_DIR, existing);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  sale.photos[stage][slot] = req.file.filename;
  saveDB(db);
  res.json({ ok: true, filename: req.file.filename });
});

app.delete("/api/sales/:saleId/photos/:stage/:slot", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { stage, slot } = req.params;
  const filename = sale.photos && sale.photos[stage] && sale.photos[stage][slot];
  if (filename) {
    const filePath = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    sale.photos[stage][slot] = null;
    saveDB(db);
  }
  res.json({ ok: true });
});

// Serves an actual photo file - requires login, same as everything else in this app.
app.get("/api/photos/:filename", requireEmployee, (req, res) => {
  const filePath = path.join(PHOTOS_DIR, req.params.filename);
  if (!filePath.startsWith(PHOTOS_DIR)) return res.status(400).end(); // guards against path traversal
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

function requireOwner(req, res, next) {
  if (req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Owner login required." });
}
function requireManager(req, res, next) {
  if (req.auth.role === "manager" || req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Manager login required." });
}
function requireEmployee(req, res, next) {
  if (req.auth.role === "employee" || req.auth.role === "manager" || req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Login required." });
}
function requireSales(req, res, next) {
  if (req.auth.role === "sales" || req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Sales login required." });
}
// Any logged-in role at all - used specifically for shared things like notes, where a
// sales rep needs the same access as everyone else without also opening up unrelated
// things like upsells or photo uploads that they were never asked to have.
function requireAnyStaff(req, res, next) {
  if (["employee", "manager", "owner", "sales"].includes(req.auth.role)) return next();
  return res.status(401).json({ error: "Login required." });
}

// ---------- session / login ----------
app.get("/api/session", (req, res) => {
  const db = loadDB();
  if (req.auth.role === "owner") return res.json({ role: "owner", shopLocation: SHOP_LOCATION_LABEL });
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    if (mgr) return res.json({ role: "manager", managerId: mgr.id, name: mgr.name, shopLocation: SHOP_LOCATION_LABEL });
  }
  if (req.auth.role === "employee") {
    const emp = db.employees.find((e) => e.id === req.auth.id);
    if (emp) return res.json({ role: "employee", employeeId: emp.id, name: emp.name, shopLocation: SHOP_LOCATION_LABEL });
  }
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    if (rep) return res.json({ role: "sales", salesRepId: rep.id, name: rep.name, shopLocation: SHOP_LOCATION_LABEL });
  }
  return res.json({ role: null, ownerPinSet: !!db.ownerPinHash, shopLocation: SHOP_LOCATION_LABEL });
});

app.post("/api/setup/owner-pin", (req, res) => {
  const db = loadDB();
  if (db.ownerPinHash) return res.status(400).json({ error: "Owner PIN already set." });
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });
  db.ownerPinHash = hash(pin);
  saveDB(db);
  setAuthCookie(res, { role: "owner" });
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const db = loadDB();
  const { pin } = req.body;
  if (db.ownerPinHash && hash(pin) === db.ownerPinHash) {
    setAuthCookie(res, { role: "owner" });
    return res.json({ role: "owner" });
  }
  const mgr = db.managers.find((m) => m.pinHash === hash(pin));
  if (mgr) {
    setAuthCookie(res, { role: "manager", id: mgr.id });
    return res.json({ role: "manager", managerId: mgr.id, name: mgr.name });
  }
  const emp = db.employees.find((e) => e.pinHash === hash(pin));
  if (emp) {
    setAuthCookie(res, { role: "employee", id: emp.id });
    return res.json({ role: "employee", employeeId: emp.id, name: emp.name });
  }
  const rep = db.salesReps.find((r) => r.pinHash === hash(pin));
  if (rep) {
    setAuthCookie(res, { role: "sales", id: rep.id });
    return res.json({ role: "sales", salesRepId: rep.id, name: rep.name });
  }
  return res.status(401).json({ error: "Incorrect PIN." });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

// ---------- employees (owner or manager can manage; employee can read own record) ----------
app.get("/api/employees", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.employees.map((e) => ({
    id: e.id, name: e.name, commissionRate: e.commissionRate, walkInCommissionRate: e.walkInCommissionRate || 0,
    payType: e.payType || null, salaryPerPeriod: e.salaryPerPeriod || 0, hourlyRate: e.hourlyRate || 0, carCommissionRate: e.carCommissionRate || 0,
  })));
});

app.post("/api/employees", requireManager, (req, res) => {
  const db = loadDB();
  const { name, commissionRate, walkInCommissionRate, pin, payType, salaryPerPeriod, hourlyRate, carCommissionRate } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const emp = {
    id: newId(), name: name.trim(), commissionRate: parseFloat(commissionRate) || 0, walkInCommissionRate: parseFloat(walkInCommissionRate) || 0, pinHash: hash(pin),
    payType: ["salary", "hourly", "commission"].includes(payType) ? payType : null,
    salaryPerPeriod: parseFloat(salaryPerPeriod) || 0, hourlyRate: parseFloat(hourlyRate) || 0, carCommissionRate: parseFloat(carCommissionRate) || 0,
  };
  db.employees.push(emp);
  saveDB(db);
  res.json({ id: emp.id, name: emp.name, commissionRate: emp.commissionRate, walkInCommissionRate: emp.walkInCommissionRate, payType: emp.payType, salaryPerPeriod: emp.salaryPerPeriod, hourlyRate: emp.hourlyRate, carCommissionRate: emp.carCommissionRate });
});

app.patch("/api/employees/:id", requireManager, (req, res) => {
  const db = loadDB();
  const emp = db.employees.find((e) => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found." });
  if (req.body.name) emp.name = req.body.name.trim();
  if (req.body.commissionRate !== undefined) emp.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.walkInCommissionRate !== undefined) emp.walkInCommissionRate = parseFloat(req.body.walkInCommissionRate) || 0;
  if (req.body.payType !== undefined) emp.payType = ["salary", "hourly", "commission"].includes(req.body.payType) ? req.body.payType : null;
  if (req.body.salaryPerPeriod !== undefined) emp.salaryPerPeriod = parseFloat(req.body.salaryPerPeriod) || 0;
  if (req.body.hourlyRate !== undefined) emp.hourlyRate = parseFloat(req.body.hourlyRate) || 0;
  if (req.body.carCommissionRate !== undefined) emp.carCommissionRate = parseFloat(req.body.carCommissionRate) || 0;
  if (req.body.pin) emp.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/employees/:id", requireManager, (req, res) => {
  const db = loadDB();
  db.employees = db.employees.filter((e) => e.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- managers (owner only to manage) ----------
app.get("/api/managers", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.managers.map((m) => ({
    id: m.id, name: m.name, commissionRate: m.commissionRate || 0, walkInCommissionRate: m.walkInCommissionRate || 0,
    payType: m.payType || null, salaryPerPeriod: m.salaryPerPeriod || 0, hourlyRate: m.hourlyRate || 0, carCommissionRate: m.carCommissionRate || 0,
  })));
});

app.post("/api/managers", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, pin, commissionRate, walkInCommissionRate, payType, salaryPerPeriod, hourlyRate, carCommissionRate } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const mgr = {
    id: newId(), name: name.trim(), pinHash: hash(pin), commissionRate: parseFloat(commissionRate) || 0, walkInCommissionRate: parseFloat(walkInCommissionRate) || 0,
    payType: ["salary", "hourly", "commission"].includes(payType) ? payType : null,
    salaryPerPeriod: parseFloat(salaryPerPeriod) || 0, hourlyRate: parseFloat(hourlyRate) || 0, carCommissionRate: parseFloat(carCommissionRate) || 0,
  };
  db.managers.push(mgr);
  saveDB(db);
  res.json({ id: mgr.id, name: mgr.name, commissionRate: mgr.commissionRate, walkInCommissionRate: mgr.walkInCommissionRate, payType: mgr.payType, salaryPerPeriod: mgr.salaryPerPeriod, hourlyRate: mgr.hourlyRate, carCommissionRate: mgr.carCommissionRate });
});

app.patch("/api/managers/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const mgr = db.managers.find((m) => m.id === req.params.id);
  if (!mgr) return res.status(404).json({ error: "Not found." });
  if (req.body.commissionRate !== undefined) mgr.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.walkInCommissionRate !== undefined) mgr.walkInCommissionRate = parseFloat(req.body.walkInCommissionRate) || 0;
  if (req.body.payType !== undefined) mgr.payType = ["salary", "hourly", "commission"].includes(req.body.payType) ? req.body.payType : null;
  if (req.body.salaryPerPeriod !== undefined) mgr.salaryPerPeriod = parseFloat(req.body.salaryPerPeriod) || 0;
  if (req.body.hourlyRate !== undefined) mgr.hourlyRate = parseFloat(req.body.hourlyRate) || 0;
  if (req.body.carCommissionRate !== undefined) mgr.carCommissionRate = parseFloat(req.body.carCommissionRate) || 0;
  if (req.body.pin) mgr.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/managers/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.managers = db.managers.filter((m) => m.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- sales reps (owner only to manage) — the person who CLOSED the deal, distinct from
// the techs who worked it and the managers who mark it arrived/no-show. Their commission
// depends on that arrived mark, so they get no ability to touch job status themselves. ----------
app.get("/api/salesreps", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name, initials: r.initials || "", commissionRate: r.commissionRate || 0, afterHoursCommissionRate: r.afterHoursCommissionRate || 0 })));
});

app.post("/api/salesreps", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, pin, commissionRate, afterHoursCommissionRate, initials } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const rep = { id: newId(), name: name.trim(), initials: (initials || "").trim().toUpperCase(), pinHash: hash(pin), commissionRate: parseFloat(commissionRate) || 0, afterHoursCommissionRate: parseFloat(afterHoursCommissionRate) || 0 };
  db.salesReps.push(rep);
  saveDB(db);
  res.json({ id: rep.id, name: rep.name, initials: rep.initials, commissionRate: rep.commissionRate, afterHoursCommissionRate: rep.afterHoursCommissionRate });
});

app.patch("/api/salesreps/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const rep = db.salesReps.find((r) => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: "Not found." });
  if (req.body.commissionRate !== undefined) rep.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.afterHoursCommissionRate !== undefined) rep.afterHoursCommissionRate = parseFloat(req.body.afterHoursCommissionRate) || 0;
  if (req.body.initials !== undefined) rep.initials = req.body.initials.trim().toUpperCase();
  if (req.body.pin) rep.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/salesreps/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.salesReps = db.salesReps.filter((r) => r.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// Manager-safe name list, same idea as manager/employees — lets a manager assign/fix which
// sales rep gets credit for a booking, without seeing commission rates.
app.get("/api/manager/salesreps", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name })));
});

// ---------- GHL webhook (public endpoint, protected by shared secret) ----------
// Point your GoHighLevel workflow's Webhook action at:
//   POST https://your-domain.com/api/webhook/ghl?secret=YOUR_WEBHOOK_SECRET
// Body (JSON): { date, customerName, car, employeeName, baseService, basePrice, ghlOpportunityId }
app.post("/api/webhook/ghl", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const data = ghlPayload(req.body);
  if (!data.ghlOpportunityId) {
    if (!db.debugLog) db.debugLog = [];
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), contentType: req.headers["content-type"] || "(none)", failedReason: "missing ghlOpportunityId", body: req.body });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.status(400).json({ error: "ghlOpportunityId is required so we can avoid duplicates." });
  }
  const sale = upsertSaleFromGHL(db, data);
  saveDB(db);
  res.json({ ok: true, saleId: sale.id, matchedEmployees: sale.employeeIds.length });
});

// Price/Rep sync — a DIFFERENT matching strategy than everything else above. GHL's
// "Opportunity Changed" trigger (needed to catch a price change after booking) doesn't
// reliably carry the Appointment ID the booking workflow used — that's a real platform
// limitation, confirmed by testing, not a setup mistake. Contact ID is the one thing
// genuinely available on both sides, so this endpoint matches by contact instead.
// Risk, stated plainly: if the same contact has TWO unresolved (pending) bookings at once,
// this can't tell them apart and will update whichever is most recent. For a shop where a
// customer books one job at a time, this is a safe, practical tradeoff — not a perfect one.
app.post("/api/webhook/ghl/sync", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  if (!db.debugLog) db.debugLog = [];
  const { contactId, basePrice, salesRepName } = ghlPayload(req.body);
  if (!contactId) {
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "sync", failedReason: "missing contactId", body: req.body });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.status(400).json({ error: "contactId is required." });
  }
  const matches = db.sales.filter((s) => s.contactId === contactId);
  if (matches.length === 0) {
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "sync", failedReason: "no sale found with this contactId", body: req.body, knownContactIds: db.sales.map((s) => s.contactId) });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.json({ ok: true, found: false });
  }
  // Prefer the most recent still-pending booking for this contact — that's almost always
  // the one a phone call just closed. Falls back to the most recent overall if none are pending.
  const pending = matches.filter((s) => !s.status || s.status === "pending");
  const pool = pending.length ? pending : matches;
  const sale = pool.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const before = { basePrice: sale.basePrice, salesRepName: sale.salesRepName };
  if (basePrice !== undefined) sale.basePrice = parseFloat(basePrice) || 0;
  const attribution = resolveSalesRepAttribution(db, salesRepName, sale.car);
  if (attribution) {
    sale.salesRepId = attribution.salesRepId; sale.salesRepName = attribution.salesRepName; sale.isWalkIn = attribution.isWalkIn;
    if (attribution.walkInClosedByType) {
      sale.walkInClosedByType = attribution.walkInClosedByType;
      sale.walkInClosedById = attribution.walkInClosedById;
      sale.walkInClosedByName = attribution.walkInClosedByName;
    }
  }
  db.debugLog.unshift({
    receivedAt: new Date().toISOString(), endpoint: "sync", matchedSaleId: sale.id, before,
    after: { basePrice: sale.basePrice, salesRepName: sale.salesRepName },
    body: req.body,
  });
  db.debugLog = db.debugLog.slice(0, 30);
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});

// Cancellation — deliberately separate from the main webhook above. This one ONLY updates
// a job that already exists (matched by ghlOpportunityId); it never creates a new one.
// If the appointment was cancelled before it ever hit "Confirmed," there's nothing in the
// tracker to cancel, and this quietly does nothing rather than creating a phantom job.
app.post("/api/webhook/ghl/cancel", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { ghlOpportunityId } = ghlPayload(req.body);
  if (!ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  if (!sale) return res.json({ ok: true, found: false });
  sale.status = "cancelled";
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});

// Unconfirmed — a real, distinct appointment status in GHL, separate from Cancelled. This
// means the customer hasn't confirmed they're still coming, not that they've definitely
// cancelled — worth flagging for follow-up, but not treated as dead the way a cancellation is.
app.post("/api/webhook/ghl/unconfirm", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { ghlOpportunityId } = ghlPayload(req.body);
  if (!ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  if (!sale) return res.json({ ok: true, found: false });
  sale.status = "unconfirmed";
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});

// Deletion — a genuinely different outcome from cancellation. If the appointment itself
// gets deleted in GHL (not just marked cancelled), the job disappears from the tracker
// entirely rather than sticking around labeled "Cancelled." Matched by ghlOpportunityId,
// same as cancel — if nothing matches, this quietly does nothing.
app.post("/api/webhook/ghl/delete", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { ghlOpportunityId } = ghlPayload(req.body);
  if (!ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const before = db.sales.length;
  db.sales = db.sales.filter((s) => s.ghlOpportunityId !== ghlOpportunityId);
  const found = db.sales.length < before;
  saveDB(db);
  res.json({ ok: true, found });
});

// Diagnostic endpoint — logs whatever GHL actually sends, no matter the shape, so we can
// see real payloads for events we haven't mapped yet (like checking whether a deleted
// appointment secretly fires a status-change event under a status we haven't tried).
app.post("/api/webhook/ghl/debug", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  if (!db.debugLog) db.debugLog = [];
  db.debugLog.unshift({ receivedAt: new Date().toISOString(), contentType: req.headers["content-type"] || "(none)", body: req.body });
  db.debugLog = db.debugLog.slice(0, 30); // keep only the most recent 30
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/owner/debug-log", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.debugLog || []);
});

app.post("/api/owner/debug-log/clear", requireOwner, (req, res) => {
  const db = loadDB();
  db.debugLog = [];
  saveDB(db);
  res.json({ ok: true });
});

// Lets the owner test the automatic job-creation flow right from the dashboard,
// without needing GoHighLevel wired up yet or any external tool.
app.post("/api/owner/simulate-webhook", requireOwner, (req, res) => {
  const db = loadDB();
  const fakeOpportunityId = "test_" + newId();
  const sale = upsertSaleFromGHL(db, { ...req.body, ghlOpportunityId: fakeOpportunityId });
  saveDB(db);
  res.json({ ok: true, saleId: sale.id, matchedEmployees: sale.employeeIds.length });
});

// ---------- manual fallback entry (owner or manager — for walk-ins or if GHL sync misses one) ----------
app.post("/api/sales", requireManager, (req, res) => {
  const db = loadDB();
  const { date, customerName, car, employeeIds, baseService, basePrice } = req.body;
  if (!car || !employeeIds || !employeeIds.length) return res.status(400).json({ error: "Car and at least one employee are required." });
  const names = employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean);
  // Every date in this app is compared as a raw ISO string (inRange does a plain >= / <=
  // string comparison, not a real Date comparison) - so it MUST be normalized into the
  // exact same full ISO-with-Z format everything else uses. A datetime-local input's raw
  // value ("2026-09-16T14:00", no seconds, no timezone) stored as-is would silently fail
  // to match Job Status or any calendar's date range, even though it looks fine anywhere
  // that just displays the date rather than filtering by it (like Search).
  const normalizedDate = date ? normalizeDate(date) : null;
  const initialDate = normalizedDate || new Date().toISOString();
  const sale = {
    id: newId(),
    date: initialDate,
    closedAt: initialDate, // set at creation so a later reschedule never has to guess what the original date was
    customerName: customerName || "",
    car,
    employeeIds,
    employeeNames: names.join(", ") || "Unassigned",
    baseService: baseService || "",
    basePrice: parseFloat(basePrice) || 0,
    syncedFromGHL: false,
    upsells: [],
    status: "pending",
    completed: false,
    paid: false,
  };
  db.sales.push(sale);
  saveDB(db);
  res.json({ ok: true, id: sale.id });
});

app.delete("/api/sales/:id", requireManager, (req, res) => {
  const db = loadDB();
  db.sales = db.sales.filter((s) => s.id !== req.params.id);
  // Cash that was auto-logged from this job's payment has nothing left to point at once the
  // job is gone - leaving it would overstate cash on hand with money nobody can trace.
  db.cashEntries = db.cashEntries.filter((e) => !(e.autoFromJob && e.saleId === req.params.id));
  saveDB(db);
  res.json({ ok: true });
});

// Lets the owner test the cancellation flow from the dashboard, same idea as simulate-webhook.
app.post("/api/owner/simulate-cancel", requireOwner, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.body.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  sale.status = "cancelled";
  saveDB(db);
  res.json({ ok: true });
});

// Lets the owner test the deletion flow — the job should actually vanish, not just get marked.
app.post("/api/owner/simulate-delete", requireOwner, (req, res) => {
  const db = loadDB();
  const before = db.sales.length;
  db.sales = db.sales.filter((s) => s.id !== req.body.saleId);
  const found = db.sales.length < before;
  saveDB(db);
  res.json({ ok: true, found });
});

// ---------- manager job-status updates (arrived / completed / paid) ----------
// Manager-safe employee list — names only, no commission rates or PINs.
app.get("/api/manager/employees", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.employees.map((e) => ({ id: e.id, name: e.name })));
});

// So a manager can mark THEMSELVES (or another manager) as having also physically
// worked a car, separate from the tech assignment.
app.get("/api/manager/managers-list", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.managers.map((m) => ({ id: m.id, name: m.name })));
});

// So a manager can assign or fix which real sales rep gets credit for a job — no
// commission rates or PINs exposed, just names.
app.get("/api/manager/salesreps-list", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name })));
});

// ---------- attendance — who showed up, who didn't, who worked a half day ----------
// ---------- cash and expense tracker ----------
// Managers log entries but only ever see their OWN log — never shop-wide totals. Full
// visibility and editing across everyone belongs to the owner only. This is a deliberate
// boundary, not an oversight: managers track what they spend, they don't see the till.
const CASH_CATEGORIES = ["Customer Payment", "Supplies", "Tools", "Misc", "Other"];

function actorInfo(req, db) {
  if (req.auth.role === "owner") return { type: "owner", id: "owner", name: "Owner" };
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    return { type: "manager", id: req.auth.id, name: mgr ? mgr.name : "Removed manager" };
  }
  if (req.auth.role === "employee") {
    const emp = db.employees.find((e) => e.id === req.auth.id);
    return { type: "employee", id: req.auth.id, name: emp ? emp.name : "Removed employee" };
  }
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    return { type: "sales", id: req.auth.id, name: rep ? rep.name : "Removed rep" };
  }
  return { type: "unknown", id: req.auth.id, name: "Unknown" };
}

app.post("/api/manager/cash-entries", requireManager, (req, res) => {
  const db = loadDB();
  const { type, amount, category, note, isOnline } = req.body;
  if (!["cashIn", "cashOut", "cardExpense", "bankDeposit"].includes(type)) return res.status(400).json({ error: "Invalid entry type." });
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "A real amount is required." });
  const actor = actorInfo(req, db);
  const entry = {
    id: newId(), type, amount: amt, category: category && CASH_CATEGORIES.includes(category) ? category : "Other",
    note: (note || "").trim(), isOnline: !!isOnline, receiptPhoto: null,
    enteredByType: actor.type, enteredById: actor.id, enteredByName: actor.name,
    timestamp: new Date().toISOString(),
  };
  db.cashEntries.unshift(entry);
  saveDB(db);
  res.json(entry);
});

// A manager's own log only — never shop-wide totals. The owner sees everyone through the
// separate /api/owner/cash-entries endpoint below.
app.get("/api/my/cash-entries", requireManager, (req, res) => {
  const db = loadDB();
  const actor = actorInfo(req, db);
  const mine = db.cashEntries.filter((e) => e.enteredByType === actor.type && e.enteredById === actor.id);
  res.json(mine.slice(0, 50));
});

app.patch("/api/manager/cash-entries/:id", requireManager, (req, res) => {
  const db = loadDB();
  const entry = db.cashEntries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  const actor = actorInfo(req, db);
  // A manager can only fix their own entries; the owner can fix anyone's.
  if (actor.type !== "owner" && !(entry.enteredByType === actor.type && entry.enteredById === actor.id)) {
    return res.status(403).json({ error: "You can only edit your own entries." });
  }
  if (req.body.amount !== undefined) entry.amount = parseFloat(req.body.amount) || entry.amount;
  if (req.body.category !== undefined && CASH_CATEGORIES.includes(req.body.category)) entry.category = req.body.category;
  if (req.body.note !== undefined) entry.note = req.body.note.trim();
  if (req.body.isOnline !== undefined) entry.isOnline = !!req.body.isOnline;
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/manager/cash-entries/:id", requireManager, (req, res) => {
  const db = loadDB();
  const entry = db.cashEntries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  const actor = actorInfo(req, db);
  if (actor.type !== "owner" && !(entry.enteredByType === actor.type && entry.enteredById === actor.id)) {
    return res.status(403).json({ error: "You can only delete your own entries." });
  }
  if (entry.receiptPhoto) {
    const p = path.join(PHOTOS_DIR, entry.receiptPhoto);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  db.cashEntries = db.cashEntries.filter((e) => e.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

const receiptUpload = multer({ storage: photoStorage, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (!/^image\//.test(file.mimetype)) return cb(new Error("Receipts must be an image."));
  cb(null, true);
} });
app.post("/api/manager/cash-entries/:id/receipt", requireManager, receiptUpload.single("receipt"), (req, res) => {
  const db = loadDB();
  const entry = db.cashEntries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  const actor = actorInfo(req, db);
  if (actor.type !== "owner" && !(entry.enteredByType === actor.type && entry.enteredById === actor.id)) {
    return res.status(403).json({ error: "You can only attach a receipt to your own entry." });
  }
  if (!req.file) return res.status(400).json({ error: "No receipt file received." });
  if (entry.receiptPhoto) {
    const oldPath = path.join(PHOTOS_DIR, entry.receiptPhoto);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  entry.receiptPhoto = req.file.filename;
  saveDB(db);
  res.json({ ok: true, filename: req.file.filename });
});

// Full visibility, owner-only — every entry from every manager, plus real totals.
app.get("/api/owner/cash-entries", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const entries = db.cashEntries.filter((e) => e.timestamp >= start && e.timestamp <= end);
  // "Cash in" specifically means cash collected from customers - the money that actually
  // enters the drawer. Depositing that cash into the bank is a separate, later event, and
  // reduces cash on hand the same way an expense would, but gets tracked as its own real
  // number rather than lumped in with generic spending.
  const totalCashIn = entries.filter((e) => e.type === "cashIn").reduce((a, e) => a + e.amount, 0);
  const totalCashOut = entries.filter((e) => e.type === "cashOut").reduce((a, e) => a + e.amount, 0);
  const totalCardExpense = entries.filter((e) => e.type === "cardExpense").reduce((a, e) => a + e.amount, 0);
  const totalBankDeposits = entries.filter((e) => e.type === "bankDeposit").reduce((a, e) => a + e.amount, 0);
  const byCategory = {};
  entries.filter((e) => e.type !== "cashIn" && e.type !== "bankDeposit").forEach((e) => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
  // Net Cash on Hand is a running balance - what's actually sitting in the drawer right
  // now - not a per-period metric. It's calculated from every entry ever logged, completely
  // independent of whatever Day/Week/Month/Year is selected above. A big one-time catch-up
  // deposit logged in one month shouldn't keep suppressing this number in every month after,
  // the way it would if this were scoped to the same period as everything else on this page.
  const allEntries = db.cashEntries;
  const allTimeCashIn = allEntries.filter((e) => e.type === "cashIn").reduce((a, e) => a + e.amount, 0);
  const allTimeCashOut = allEntries.filter((e) => e.type === "cashOut").reduce((a, e) => a + e.amount, 0);
  const allTimeBankDeposits = allEntries.filter((e) => e.type === "bankDeposit").reduce((a, e) => a + e.amount, 0);
  res.json({
    entries: entries.slice(0, 200),
    totalCashIn, totalCashOut, totalCardExpense, totalBankDeposits,
    // Floored at zero - if deposits ever exceed everything tracked as coming in (e.g. a
    // catch-up deposit for cash that predates using this feature at all), the raw
    // subtraction would go negative, which isn't a real number, just an artifact of where
    // tracking started.
    netCash: Math.max(0, allTimeCashIn - allTimeCashOut - allTimeBankDeposits),
    byCategory: Object.entries(byCategory).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
  });
});

app.get("/api/manager/attendance", requireManager, (req, res) => {
  const db = loadDB();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const people = [
    ...db.employees.map((e) => ({ id: e.id, name: e.name, type: "employee" })),
    ...db.managers.map((m) => ({ id: m.id, name: m.name, type: "manager" })),
  ];
  const records = db.attendance.filter((a) => a.date === date);
  res.json(people.map((p) => {
    const rec = records.find((r) => r.personType === p.type && r.personId === p.id);
    return { ...p, status: rec ? rec.status : null, startTime: rec ? rec.startTime || "" : "", endTime: rec ? rec.endTime || "" : "" };
  }));
});

app.post("/api/manager/attendance", requireManager, (req, res) => {
  const db = loadDB();
  const { personType, personId, date, status, startTime, endTime } = req.body;
  if (!personType || !personId || !date) return res.status(400).json({ error: "personType, personId, and date are required." });
  const existing = db.attendance.find((a) => a.personType === personType && a.personId === personId && a.date === date);
  if (!status && startTime === undefined && endTime === undefined) {
    db.attendance = db.attendance.filter((a) => a !== existing);
  } else if (existing) {
    if (status !== undefined) existing.status = status;
    // Usually 9-5 or 9-6, but not every day is usual — these stay optional and blank
    // unless a manager actually fills in a different time for that specific day.
    if (startTime !== undefined) existing.startTime = startTime;
    if (endTime !== undefined) existing.endTime = endTime;
  } else {
    db.attendance.push({ id: newId(), personType, personId, date, status: status || null, startTime: startTime || "", endTime: endTime || "" });
  }
  saveDB(db);
  res.json({ ok: true });
});

// Owner-side rollup — total days present/absent/half-day per person over a period, for payroll.
app.get("/api/owner/attendance-summary", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const startDay = start.slice(0, 10), endDay = end.slice(0, 10);
  const records = db.attendance.filter((a) => a.date >= startDay && a.date <= endDay);
  const people = [
    ...db.employees.map((e) => ({ id: e.id, name: e.name, type: "employee" })),
    ...db.managers.map((m) => ({ id: m.id, name: m.name, type: "manager" })),
  ];
  res.json(people.map((p) => {
    const mine = records.filter((r) => r.personType === p.type && r.personId === p.id);
    return {
      ...p,
      present: mine.filter((r) => r.status === "present").length,
      absent: mine.filter((r) => r.status === "absent").length,
      halfDay: mine.filter((r) => r.status === "half_day").length,
    };
  }));
});

// Finds every job missing a base price or a sales rep, regardless of when it happened —
// this is the cleanup tool for catching up jobs that came in before a fix was live.
// Shown up but not yet paid — the exact gap between "Shown up" and "Total revenue" on the
// dashboard, surfaced directly instead of making someone notice the two numbers don't
// match and go hunting for why. No date restriction, same as Cleanup, since this is meant
// to catch anything that's fallen through the cracks regardless of when it happened.
app.get("/api/manager/unpaid-arrived", requireManager, (req, res) => {
  const db = loadDB();
  const jobs = db.sales.filter((s) => s.status === "arrived" && !s.paid);
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, car: s.car, customerName: s.customerName, customerPhone: s.customerPhone,
    baseService: s.baseService, basePrice: s.basePrice || 0, total: saleTotal(s), employeeNames: s.employeeNames || "Unassigned",
  })).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

// Appointments scheduled for today or any day before it that were never marked with any
// real outcome at all - not arrived, not no-show, not cancelled, not completed. This
// almost always means someone forgot to click anything after the appointment happened,
// not that the appointment genuinely hasn't occurred yet. Deliberately excludes anything
// scheduled for a future day, since those correctly haven't happened yet and shouldn't be
// flagged as a problem.
app.get("/api/manager/unmarked-appointments", requireManager, (req, res) => {
  const db = loadDB();
  const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const cutoff = endOfDayEastern(todayEastern);
  const jobs = db.sales.filter((s) =>
    s.date <= cutoff && !["arrived", "no_show", "cancelled"].includes(s.status) && !s.completed
  );
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, car: s.car, customerName: s.customerName, customerPhone: s.customerPhone,
    baseService: s.baseService, basePrice: s.basePrice || 0, employeeNames: s.employeeNames || "Unassigned",
    status: s.status || "pending",
  })).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

app.get("/api/manager/needs-cleanup", requireManager, (req, res) => {
  const db = loadDB();
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && (!s.basePrice || (!s.salesRepId && !s.isWalkIn && !s.isOnlineBooking) || !s.baseService));
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
    employeeNames: s.employeeNames || "Unassigned", baseService: s.baseService || "",
    salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned", isWalkIn: !!s.isWalkIn, isOnlineBooking: !!s.isOnlineBooking,
    walkInClosedByType: s.walkInClosedByType || null, walkInClosedById: s.walkInClosedById || null, walkInClosedByName: s.walkInClosedByName || null,
    basePrice: s.basePrice || 0, missingPrice: !s.basePrice, missingRep: !s.salesRepId && !s.isWalkIn && !s.isOnlineBooking, missingService: !s.baseService,
  })).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

// ---------- Cross-location: for the standalone combined sales rep tracker app ----------
// Read-only and one narrow write action, all gated on CROSS_LOCATION_SECRET, never the
// session/PIN system, since these are called server-to-server with no logged-in owner.

// Raw individual close records per rep, not pre-aggregated - the combining app computes
// totals, trends, day-of-week and service breakdowns, and duplicate detection itself from
// this, so each location's own endpoint stays simple and low-risk.
app.get("/api/cross-location/salesrep-closes", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  // Two genuinely different questions need two different date bases. "appointment" (the
  // default) filters by when the job is scheduled and matches Payroll exactly - this is
  // what Combined's period stats need, so they agree with each location's own Payroll page.
  // "closed" filters by when the deal was actually closed, regardless of when the
  // appointment happens - this is what a live "who's closing deals today" leaderboard
  // needs, matching Closing Activity instead.
  const dateBasis = req.query.dateBasis === "closed" ? (s) => (s.closedAt || s.date) : (s) => s.date;
  const relevant = revenueEligible(db.sales.filter((s) => s.salesRepId && inRange(dateBasis(s), start, end)), db);
  const byRep = {};
  relevant.forEach((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    if (!rep) return;
    if (!byRep[rep.name]) byRep[rep.name] = { name: rep.name, commissionRate: rep.commissionRate || 0, afterHoursCommissionRate: rep.afterHoursCommissionRate || 0, closes: [] };
    const duringHours = isDuringBusinessHours(s.closedAt || s.date);
    byRep[rep.name].closes.push({
      id: s.id, car: s.car, customerName: s.customerName, date: s.date, closedAt: s.closedAt || s.date,
      basePrice: parseFloat(s.basePrice) || 0, baseService: s.baseService || "", status: s.status || "pending", duringHours,
    });
  });
  res.json({ locationLabel: SHOP_LOCATION_LABEL, perRep: Object.values(byRep) });
});

// Same shape as the owner's own Cleanup list, so the combining app can render it identically.
app.get("/api/cross-location/cleanup-list", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && (!s.basePrice || (!s.salesRepId && !s.isWalkIn && !s.isOnlineBooking) || !s.baseService));
  res.json({
    locationLabel: SHOP_LOCATION_LABEL,
    jobs: jobs.map((s) => ({
      id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
      employeeNames: s.employeeNames || "Unassigned", baseService: s.baseService || "",
      salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned", isWalkIn: !!s.isWalkIn, isOnlineBooking: !!s.isOnlineBooking,
      basePrice: s.basePrice || 0, missingPrice: !s.basePrice, missingRep: !s.salesRepId && !s.isWalkIn && !s.isOnlineBooking, missingService: !s.baseService,
    })).sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

// Deliberately narrow - only the exact fields Cleanup itself allows fixing, nothing else.
// Same as tapping the fix directly inside this tracker; just reachable from the combined app.
app.post("/api/cross-location/cleanup-fix", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.body.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { basePrice, baseService, isWalkIn, isOnlineBooking, salesRepId } = req.body;
  if (basePrice !== undefined) sale.basePrice = parseFloat(basePrice) || 0;
  if (baseService !== undefined) sale.baseService = baseService;
  if (isWalkIn !== undefined) sale.isWalkIn = !!isWalkIn;
  if (isOnlineBooking !== undefined) sale.isOnlineBooking = !!isOnlineBooking;
  if (salesRepId !== undefined) {
    const rep = db.salesReps.find((r) => r.id === salesRepId);
    sale.salesRepId = salesRepId;
    sale.salesRepName = rep ? rep.name : sale.salesRepName;
  }
  saveDB(db);
  res.json({ ok: true });
});

// Auto-fix as much of Cleanup as can be safely derived from data already on the job —
// the car/title text — using the exact same detection already proven for the live GHL
// flow and bulk import. Only acts when a real pattern is found; price can never be
// guessed and always needs a human, so it's reported but never touched here.
app.post("/api/manager/cleanup-auto-fix", requireManager, (req, res) => {
  const db = loadDB();
  const dryRun = !!req.body.dryRun;
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && (!s.basePrice || (!s.salesRepId && !s.isWalkIn) || !s.baseService));
  const results = { fixedService: 0, fixedRep: 0, stillNeedsPrice: 0, stillNeedsManualService: 0, stillNeedsManualRep: 0, preview: [] };

  jobs.forEach((s) => {
    const hadService = !!s.baseService;
    const hadRep = !!(s.salesRepId || s.isWalkIn);
    const hadPrice = !!s.basePrice;

    let serviceFix = null, repFix = null;
    if (!hadService) {
      const guessed = guessServiceFromTitle(s.car);
      if (guessed) serviceFix = guessed;
    }
    if (!hadRep) {
      const rep = repFromTitleInitials(db, s.car);
      if (rep) repFix = rep;
    }

    if (serviceFix || repFix) {
      results.preview.push({ id: s.id, car: s.car, serviceFix, repFix: repFix ? repFix.name : null });
      if (!dryRun) {
        if (serviceFix) { logAudit(db, req, s, "Service", s.baseService, serviceFix); s.baseService = serviceFix; }
        if (repFix) { logAudit(db, req, s, "Sales rep", s.salesRepName, repFix.name); s.salesRepId = repFix.id; s.salesRepName = repFix.name; s.isWalkIn = false; }
      }
      if (serviceFix) results.fixedService++;
      if (repFix) results.fixedRep++;
    }

    if (!hadPrice) results.stillNeedsPrice++;
    if (!hadService && !serviceFix) results.stillNeedsManualService++;
    if (!hadRep && !repFix) results.stillNeedsManualRep++;
  });

  if (!dryRun) saveDB(db);
  res.json({ ok: true, dryRun, totalJobsChecked: jobs.length, ...results });
});

// Bulk-mark several jobs as Online Booking at once — for the real scenario where a
// backlog of genuine website self-bookings all sit flagged as "missing a rep" simply
// because nobody typed initials into a title nobody filled out themselves.
app.post("/api/manager/cleanup-mark-online", requireManager, (req, res) => {
  const db = loadDB();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "No jobs selected." });
  let fixed = 0;
  ids.forEach((id) => {
    const sale = db.sales.find((s) => s.id === id);
    if (!sale) return;
    logAudit(db, req, sale, "Sales rep", sale.salesRepName, "Online Booking");
    sale.isOnlineBooking = true;
    sale.salesRepId = null; sale.salesRepName = "Online Booking"; sale.isWalkIn = false;
    sale.walkInClosedByType = null; sale.walkInClosedById = null; sale.walkInClosedByName = null;
    fixed++;
  });
  saveDB(db);
  res.json({ ok: true, fixed });
});

// Which GHL calendar means which service — a far more reliable signal than the title text,
// since a genuine online booking's title is often just the customer's name with nothing to
// guess a service from at all. The calendar itself is unambiguous.
app.get("/api/manager/calendar-service-map", requireManager, (req, res) => {
  const db = loadDB();
  // Every distinct calendarId already seen in the data, with one real example so the owner
  // can recognize which is which without needing to go look it up in GHL.
  const seen = {};
  db.sales.filter((s) => s.calendarId).forEach((s) => {
    if (!seen[s.calendarId]) seen[s.calendarId] = { calendarId: s.calendarId, exampleCar: s.car, exampleService: s.baseService || "" };
  });
  res.json({ map: db.calendarServiceMap || {}, seenCalendars: Object.values(seen) });
});

app.post("/api/manager/calendar-service-map", requireManager, (req, res) => {
  const db = loadDB();
  const { calendarId, service } = req.body;
  if (!calendarId || !service) return res.status(400).json({ error: "calendarId and service are required." });
  if (!db.calendarServiceMap) db.calendarServiceMap = {};
  db.calendarServiceMap[calendarId] = service;
  saveDB(db);
  res.json({ ok: true, map: db.calendarServiceMap });
});

// Re-checks every job still missing a service against the calendar mapping above — for
// jobs that already have a calendarId stored but no title-text keyword to guess from.
app.post("/api/manager/cleanup-fix-by-calendar", requireManager, (req, res) => {
  const db = loadDB();
  const dryRun = !!req.body.dryRun;
  const map = db.calendarServiceMap || {};
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && !s.baseService && s.calendarId && map[s.calendarId]);
  const preview = jobs.map((s) => ({ id: s.id, car: s.car, calendarId: s.calendarId, serviceFix: map[s.calendarId] }));
  if (!dryRun) {
    jobs.forEach((s) => {
      logAudit(db, req, s, "Service", s.baseService, map[s.calendarId]);
      s.baseService = map[s.calendarId];
    });
    saveDB(db);
  }
  res.json({ ok: true, dryRun, fixed: jobs.length, preview });
});

// Tips - pick a job, amount auto-splits evenly among whoever's assigned to it.
app.post("/api/manager/tips", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const { saleId, amount } = req.body;
  const sale = db.sales.find((s) => s.id === saleId);
  const amt = parseFloat(amount);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  if (!amt || amt <= 0) return res.status(400).json({ error: "A real amount is required." });
  // Techs AND any manager who helped hands-on both count toward the split - same
  // "who actually worked this car" logic already used for car commission.
  const workers = [
    ...saleEmployeeIds(sale).map((id) => ({ personType: "employee", personId: id })),
    ...(sale.managerHelperIds || []).map((id) => ({ personType: "manager", personId: id })),
  ];
  if (workers.length === 0) return res.status(400).json({ error: "This job has no one assigned to it yet." });
  const each = Math.round((amt / workers.length) * 100) / 100;
  const split = workers.map((w) => {
    const person = w.personType === "employee" ? db.employees.find((e) => e.id === w.personId) : db.managers.find((m) => m.id === w.personId);
    return { personType: w.personType, personId: w.personId, name: person ? person.name : "Removed person", amount: each };
  });
  const actor = actorInfo(req, db);
  const tip = { id: newId(), saleId, car: sale.car, date: sale.date, amount: amt, split, loggedByName: actor.name, timestamp: new Date().toISOString() };
  db.tips.push(tip);
  saveDB(db);
  res.json({ ok: true, tip });
});

app.get("/api/manager/tips", requireManager, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  res.json(db.tips.filter((t) => t.timestamp >= start && t.timestamp <= end).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)));
});

// Cash received against a job is kept in lockstep with the Cash & Expenses log. Marking a
// job paid in cash creates (or updates) ONE linked "cashIn" entry for the amount actually
// handed over; unmarking it removes that entry again, so cash on hand can never drift away
// from what Job Status says was collected. The cash entry is the single source of truth for
// the amount - Job Status reads it back from there rather than keeping a second copy that
// could disagree if someone later corrects the entry in Cash Log.
function linkedCashEntries(db, saleId) {
  return db.cashEntries.filter((e) => e.autoFromJob && e.saleId === saleId);
}
function reconcileCashPayment(db, req, sale, requestedAmount) {
  const linked = linkedCashEntries(db, sale.id);
  const existing = linked[0] || null;
  if (!sale.paidCash) {
    if (linked.length > 0) {
      const before = linked.reduce((a, e) => a + e.amount, 0);
      db.cashEntries = db.cashEntries.filter((e) => !(e.autoFromJob && e.saleId === sale.id));
      logAudit(db, req, sale, "Cash received", before, 0);
    }
    return;
  }
  // Newly marked with no amount given (e.g. the quick button on Unpaid Arrivals) defaults to
  // the full job total; an unrelated update to an already-logged job keeps what's there.
  const amount = requestedAmount !== undefined ? requestedAmount : existing ? existing.amount : Math.round(saleTotal(sale) * 100) / 100;
  if (!(amount > 0)) return; // a job with no price yet has no cash amount to log
  if (existing) {
    if (linked.length > 1) db.cashEntries = db.cashEntries.filter((e) => !(e.autoFromJob && e.saleId === sale.id && e !== existing));
    if (existing.amount !== amount) {
      logAudit(db, req, sale, "Cash received", existing.amount, amount);
      existing.amount = amount;
    }
    return;
  }
  const actor = actorInfo(req, db);
  db.cashEntries.unshift({
    id: newId(), type: "cashIn", amount, category: "Customer Payment",
    note: `${sale.car || "Job"}${sale.customerName ? " — " + sale.customerName : ""}`,
    isOnline: false, receiptPhoto: null, saleId: sale.id, autoFromJob: true,
    enteredByType: actor.type, enteredById: actor.id, enteredByName: actor.name,
    timestamp: new Date().toISOString(),
  });
  logAudit(db, req, sale, "Cash received", 0, amount);
}

app.get("/api/manager/jobs", requireManager, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales.filter((s) => inRange(s.date, start, end));
  const cashBySale = {};
  db.cashEntries.forEach((e) => { if (e.autoFromJob && e.saleId) cashBySale[e.saleId] = (cashBySale[e.saleId] || 0) + e.amount; });
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
    cashPaidAmount: cashBySale[s.id] || 0,
    employeeIds: saleEmployeeIds(s), employeeNames: s.employeeNames || "Unassigned", baseService: s.baseService,
    managerHelperIds: s.managerHelperIds || [], managerHelperNames: s.managerHelperNames || "",
    salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned", isWalkIn: !!s.isWalkIn,
    walkInClosedByType: s.walkInClosedByType || null, walkInClosedById: s.walkInClosedById || null, walkInClosedByName: s.walkInClosedByName || null,
    basePrice: s.basePrice || 0, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db),
    status: s.status || (s.arrived ? "arrived" : "pending"), completed: !!s.completed, paid: !!s.paid, paymentMethod: s.paymentMethod || null, paidCash: !!s.paidCash, paidCard: !!s.paidCard,
    photos: s.photos || { before: {}, after: {} }, notes: s.notes || [],
  })));
});

app.patch("/api/manager/jobs/:id", requireManager, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  // Manual price correction — the price GHL/sync captured isn't always final; a customer
  // can negotiate down after the fact. This flows through to every downstream number
  // automatically (total, commission math), since everything reads from this one field.
  if (req.body.basePrice !== undefined) {
    const newPrice = parseFloat(req.body.basePrice) || 0;
    logAudit(db, req, sale, "Base price", sale.basePrice, newPrice);
    sale.basePrice = newPrice;
  }
  // Which service this actually is — needed for the Window Tint / Ceramic Coating / PPF
  // column split, and previously had no way to set or fix it anywhere in the app.
  if (req.body.baseService !== undefined) {
    logAudit(db, req, sale, "Service", sale.baseService, req.body.baseService);
    sale.baseService = req.body.baseService;
  }
  // GHL doesn't reliably notify us when someone just edits an appointment's title after
  // booking (no trigger fires for a plain edit) — this makes the manual fix a quick inline
  // correction instead of something requiring a database edit.
  if (req.body.car !== undefined && req.body.car.trim()) {
    logAudit(db, req, sale, "Car/Title", sale.car, req.body.car.trim());
    sale.car = req.body.car.trim();
  }
  // Manual date/time correction — for the rare case an appointment's real time needs fixing
  // directly (a reschedule that didn't sync correctly, a data entry mistake, etc). Uses the
  // same wall-clock-to-UTC conversion as everything else, so this stays correct across DST.
  if (req.body.date !== undefined && req.body.date) {
    const normalized = normalizeDate(req.body.date);
    if (normalized) {
      // If this job has never had a real closedAt, this edit IS a reschedule of whatever
      // the date currently is - capture that current value now, before it's overwritten,
      // so this appointment's original scheduled time is preserved as its close date
      // forever, rather than drifting to match every future reschedule.
      if (!sale.closedAt && sale.date) sale.closedAt = sale.date;
      logAudit(db, req, sale, "Date/Time", sale.date, normalized);
      sale.date = normalized;
    }
  }
  // Manual correction for when the deal was actually closed — this directly decides which
  // commission rate applies (in-hours vs after-hours), so a wrong value here has real
  // dollar consequences. Same Eastern-aware parsing as the appointment date/time above.
  if (req.body.closedAt !== undefined && req.body.closedAt) {
    const normalized = normalizeDate(req.body.closedAt);
    if (normalized) {
      logAudit(db, req, sale, "Closed At", sale.closedAt, normalized);
      sale.closedAt = normalized;
    }
  }
  if (req.body.status !== undefined) sale.status = req.body.status;
  if (req.body.completed !== undefined) sale.completed = !!req.body.completed;
  // How much of the payment was actually cash - validated before anything is changed, so a
  // bad value can never leave a half-applied update behind.
  let cashAmountRequested;
  if (req.body.cashPaidAmount !== undefined) {
    const amt = Math.round(parseFloat(req.body.cashPaidAmount) * 100) / 100;
    if (!(amt > 0)) return res.status(400).json({ error: "Enter a real cash amount." });
    cashAmountRequested = amt;
  }
  if (req.body.paid !== undefined) {
    sale.paid = !!req.body.paid;
    if (!sale.paid) { sale.paidCash = false; sale.paidCard = false; sale.paymentMethod = null; }
  }
  // Cash and card are independent toggles now, not mutually exclusive — a customer can
  // genuinely pay part cash, part card, and both need to be markable at once.
  if (req.body.paidCash !== undefined) sale.paidCash = !!req.body.paidCash;
  if (req.body.paidCard !== undefined) sale.paidCard = !!req.body.paidCard;
  if (req.body.paidCash !== undefined || req.body.paidCard !== undefined) {
    sale.paid = !!(sale.paidCash || sale.paidCard);
    sale.paymentMethod = sale.paidCash && sale.paidCard ? "both" : sale.paidCash ? "cash" : sale.paidCard ? "card" : null;
  }
  // Every path that can change cash (paidCash, paid:false which clears it, or an amount
  // edit) funnels through here, so the Cash & Expenses log always matches.
  if (req.body.paid !== undefined || req.body.paidCash !== undefined || req.body.paidCard !== undefined || cashAmountRequested !== undefined) {
    reconcileCashPayment(db, req, sale, cashAmountRequested);
  }
  if (req.body.employeeIds !== undefined) {
    sale.employeeIds = req.body.employeeIds;
    const names = req.body.employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean);
    sale.employeeNames = names.join(", ") || "Unassigned";
  }
  // Managers sometimes physically help with the work too — tracked separately from techs.
  if (req.body.managerHelperIds !== undefined) {
    sale.managerHelperIds = req.body.managerHelperIds;
    const names = req.body.managerHelperIds.map((id) => (db.managers.find((m) => m.id === id) || {}).name).filter(Boolean);
    sale.managerHelperNames = names.join(", ");
  }
  if (req.body.salesRepId !== undefined) {
    const rep = db.salesReps.find((r) => r.id === req.body.salesRepId);
    logAudit(db, req, sale, "Sales rep", sale.salesRepName, rep ? rep.name : "Unassigned");
    sale.salesRepId = req.body.salesRepId;
    sale.salesRepName = rep ? rep.name : "Unassigned";
    sale.isWalkIn = false;
    sale.isOnlineBooking = false;
  }
  // Manual override — mark any job as a walk-in/staff-booked appointment, no sales rep
  // commission applies regardless of what GHL says.
  if (req.body.isWalkIn !== undefined) {
    sale.isWalkIn = !!req.body.isWalkIn;
    if (sale.isWalkIn) { sale.salesRepId = null; sale.salesRepName = "Walk-in (booked by staff)"; sale.isOnlineBooking = false; }
    else { sale.walkInClosedByType = null; sale.walkInClosedById = null; sale.walkInClosedByName = null; }
  }
  // A genuine website self-booking — nobody actually closed this, so it correctly gets no
  // sales rep credit and no commission, but it shouldn't sit in Cleanup forever looking
  // like something's missing. This is its own real, resolved category, not an error state.
  if (req.body.isOnlineBooking !== undefined) {
    sale.isOnlineBooking = !!req.body.isOnlineBooking;
    if (sale.isOnlineBooking) {
      logAudit(db, req, sale, "Sales rep", sale.salesRepName, "Online Booking");
      sale.salesRepId = null; sale.salesRepName = "Online Booking"; sale.isWalkIn = false;
      sale.walkInClosedByType = null; sale.walkInClosedById = null; sale.walkInClosedByName = null;
    }
  }
  // Assign or change who actually closed a walk-in — attribution/tracking only, not tied
  // to any commission calculation.
  if (req.body.walkInClosedByType !== undefined && req.body.walkInClosedById !== undefined) {
    const person = req.body.walkInClosedByType === "manager"
      ? db.managers.find((m) => m.id === req.body.walkInClosedById)
      : db.employees.find((e) => e.id === req.body.walkInClosedById);
    sale.walkInClosedByType = req.body.walkInClosedByType;
    sale.walkInClosedById = req.body.walkInClosedById;
    sale.walkInClosedByName = person ? person.name : "Unknown";
  }
  saveDB(db);
  res.json({ ok: true });
});

// ---------- upsells ----------
app.post("/api/sales/:id/upsells", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  // Deliberately NOT restricted to techs assigned to the car — assignment tracks who did the
  // labor, upselling is separate. Anyone logged in can upsell any car on the schedule.
  const { name, price } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Upsell name is required." });
  sale.upsells = sale.upsells || [];
  const upsell = { id: newId(), name: name.trim(), price: parseFloat(price) || 0, employeeId: null, managerId: null, salesRepId: null };
  if (req.auth.role === "employee") upsell.employeeId = req.auth.id;
  else if (req.auth.role === "manager") upsell.managerId = req.auth.id;
  else if (req.auth.role === "sales") {
    // A rep upselling over the phone - an online booking with no assigned rep, or a
    // callback on an existing customer to add something on before they arrive.
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    upsell.salesRepId = req.auth.id;
    upsell.salesRepName = rep ? rep.name : null;
  }
  else if (req.body.employeeId) upsell.employeeId = req.body.employeeId;
  else if (req.body.managerId) upsell.managerId = req.body.managerId;
  sale.upsells.push(upsell);
  saveDB(db);
  res.json({ ok: true });
});

// A shared note log on the appointment — tech, manager, and owner can all see and add to
// it. Useful for things like "customer wants extra wax" or "called to confirm" that
// multiple people might need to know, not tied to any one person's own view.
function noteAuthorInfo(req, db) {
  if (req.auth.role === "owner") return "Owner";
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    return `${mgr ? mgr.name : "Removed manager"} (manager)`;
  }
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    return `${rep ? rep.name : "Removed rep"} (sales)`;
  }
  const emp = db.employees.find((e) => e.id === req.auth.id);
  return emp ? emp.name : "Removed employee";
}

app.post("/api/sales/:id/notes", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "Note text is required." });
  sale.notes = sale.notes || [];
  sale.notes.push({ id: newId(), text: text.trim(), authorName: noteAuthorInfo(req, db), timestamp: new Date().toISOString() });
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/sales/:id/notes/:noteId", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  sale.notes = (sale.notes || []).filter((n) => n.id !== req.params.noteId);
  saveDB(db);
  res.json({ ok: true });
});

// Fix a mistake on an upsell already logged — wrong price, wrong name typed in, whatever.
// Manager/owner only. Keeps the original attribution (who gets credit) intact, unlike
// deleting and re-adding it, which would change who it's credited to.
app.patch("/api/sales/:saleId/upsells/:upsellId", requireManager, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const upsell = (sale.upsells || []).find((u) => u.id === req.params.upsellId);
  if (!upsell) return res.status(404).json({ error: "Upsell not found." });
  if (req.body.name !== undefined && req.body.name.trim()) upsell.name = req.body.name.trim();
  if (req.body.price !== undefined) upsell.price = parseFloat(req.body.price) || 0;
  // Who gets credit for this upsell is ONE choice across everyone in the system — an
  // employee, a manager, or a sales rep — not separate bolted-on fields. Setting one
  // clears the others, so credit is never ambiguous or double-counted.
  if (req.body.creditType !== undefined) {
    upsell.employeeId = null; upsell.managerId = null; upsell.salesRepId = null; upsell.salesRepName = null;
    if (req.body.creditType === "employee" && req.body.creditId) {
      upsell.employeeId = req.body.creditId;
    } else if (req.body.creditType === "manager" && req.body.creditId) {
      upsell.managerId = req.body.creditId;
    } else if (req.body.creditType === "salesrep" && req.body.creditId) {
      const rep = db.salesReps.find((r) => r.id === req.body.creditId);
      upsell.salesRepId = req.body.creditId;
      upsell.salesRepName = rep ? rep.name : null;
    }
    // creditType === "none" (or an unmatched value) leaves it fully unassigned.
  }
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/sales/:saleId/upsells/:upsellId", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const target = (sale.upsells || []).find((u) => u.id === req.params.upsellId);
  if (!target) return res.status(404).json({ error: "Upsell not found." });
  // Employees can only undo their own entries; managers and the owner can remove any.
  if (req.auth.role === "employee" && target.employeeId !== req.auth.id) {
    return res.status(403).json({ error: "You can only remove upsells you personally logged." });
  }
  sale.upsells = (sale.upsells || []).filter((u) => u.id !== req.params.upsellId);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- employee's own data only — server enforces this, ignores any client-supplied id ----------
// The full schedule — every job, not just ones a tech is assigned to. Assignment (who worked
// the car) is now purely a manager-entered record for pay purposes; it doesn't gate who can
// log an upsell. But what shows here is only the upsells THIS person personally logged —
// not a teammate's, even on a shared car. (Managers still see everyone's, on their own board.)
app.get("/api/my/jobs", requireEmployee, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const myId = req.auth.id;
  const jobs = db.sales
    .filter((s) => inRange(s.date, start, end))
    .map((s) => ({
      id: s.id,
      date: s.date,
      car: s.car,
      customerName: s.customerName || "",
      customerPhone: s.customerPhone || "",
      baseService: s.baseService,
      employeeNames: s.employeeNames || "Unassigned",
      managerHelperNames: s.managerHelperNames || "",
      status: s.status || "pending",
      // Every upsell on this car is visible to any tech working it, so someone tag-teaming
      // a job (like Nick alongside Gio) can see what's already been upsold, even though
      // commission credit still only goes to whoever actually logged it.
      upsells: resolveUpsellNames(s.upsells || [], db),
      photos: s.photos || { before: {}, after: {} }, notes: s.notes || [],
      // basePrice and total sale $ intentionally NOT sent to employees
    }));
  res.json(jobs);
});

app.get("/api/my/performance", requireEmployee, (req, res) => {
  const db = loadDB();
  const employeeId = req.auth.role === "owner" && req.query.employeeId ? req.query.employeeId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const emp = db.employees.find((e) => e.id === employeeId);
  const mine = db.sales.filter((s) => saleEmployeeIds(s).includes(employeeId) && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));

  // Only upsells this specific person personally logged count toward their own numbers —
  // even on a shared job, a teammate's upsell isn't credited to them.
  const myUpsells = (s) => (s.upsells || []).filter((u) => u.employeeId === employeeId);
  const upsellRev = mine.reduce((a, s) => a + myUpsells(s).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
  const cars = mine.length;
  const carsWithUpsell = mine.filter((s) => myUpsells(s).length > 0).length;
  const attachRate = cars ? (carsWithUpsell / cars) * 100 : 0;

  const breakdown = {};
  mine.forEach((s) => myUpsells(s).forEach((u) => {
    const k = u.name.trim();
    breakdown[k] = breakdown[k] || { name: k, count: 0, revenue: 0 };
    breakdown[k].count += 1;
    breakdown[k].revenue += parseFloat(u.price) || 0;
  }));
  const sorted = Object.values(breakdown).sort((a, b) => b.revenue - a.revenue);
  const commission = emp && emp.commissionRate ? upsellRev * (emp.commissionRate / 100) : 0;

  // Walk-in closer commission is separate from the tech-assignment filter above — closing
  // a walk-in isn't the same thing as being assigned to physically work the car.
  const myWalkIns = db.sales.filter((s) => s.walkInClosedByType === "employee" && s.walkInClosedById === employeeId && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));
  const walkInClosedCount = myWalkIns.length;
  const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(emp, s), 0);

  const myAttendance = db.attendance.filter((a) => a.personType === "employee" && a.personId === employeeId && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
  const basePay = emp ? calculateBasePay(emp, myAttendance, mine) : { amount: 0, configured: false, carDetails: [] };
  const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "employee" && sp.personId === employeeId));
  const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "employee" && sp.personId === employeeId).amount, 0);
  const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "employee" && sp.personId === employeeId).amount, splitCount: t.split.length }));

  res.json({
    cars, attachRate, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: emp ? emp.commissionRate : 0, commission,
    walkInCommissionRate: emp ? emp.walkInCommissionRate || 0 : 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue,
    payType: emp ? emp.payType : null, salaryPerPeriod: emp ? emp.salaryPerPeriod || 0 : 0, hourlyRate: emp ? emp.hourlyRate || 0 : 0, carCommissionRate: emp ? emp.carCommissionRate || 0 : 0, basePay,
    tipsTotal, tipDetails,
    totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
  });
});

// ---------- manager's own upsell performance — managers upsell too, and get credited personally ----------
app.get("/api/manager/performance", requireManager, (req, res) => {
  const db = loadDB();
  const managerId = req.auth.role === "owner" && req.query.managerId ? req.query.managerId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const mgr = db.managers.find((m) => m.id === managerId);

  const myUpsells = (s) => (s.upsells || []).filter((u) => u.managerId === managerId);
  const relevant = db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db) && myUpsells(s).length > 0);
  const upsellRev = relevant.reduce((a, s) => a + myUpsells(s).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
  const cars = relevant.length;

  const breakdown = {};
  relevant.forEach((s) => myUpsells(s).forEach((u) => {
    const k = u.name.trim();
    breakdown[k] = breakdown[k] || { name: k, count: 0, revenue: 0 };
    breakdown[k].count += 1;
    breakdown[k].revenue += parseFloat(u.price) || 0;
  }));
  const sorted = Object.values(breakdown).sort((a, b) => b.revenue - a.revenue);
  const commission = mgr && mgr.commissionRate ? upsellRev * (mgr.commissionRate / 100) : 0;

  const myWalkIns = db.sales.filter((s) => s.walkInClosedByType === "manager" && s.walkInClosedById === managerId && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));
  const walkInClosedCount = myWalkIns.length;
  const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(mgr, s), 0);

  const myAttendance = db.attendance.filter((a) => a.personType === "manager" && a.personId === managerId && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
  const periodSales = db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));
  const basePay = mgr ? calculateBasePay(mgr, myAttendance, periodSales) : { amount: 0, configured: false, carDetails: [] };
  const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "manager" && sp.personId === managerId));
  const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "manager" && sp.personId === managerId).amount, 0);
  const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "manager" && sp.personId === managerId).amount, splitCount: t.split.length }));

  res.json({
    cars, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: mgr ? mgr.commissionRate : 0, commission,
    walkInCommissionRate: mgr ? mgr.walkInCommissionRate || 0 : 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue,
    payType: mgr ? mgr.payType : null, salaryPerPeriod: mgr ? mgr.salaryPerPeriod || 0 : 0, hourlyRate: mgr ? mgr.hourlyRate || 0 : 0, carCommissionRate: mgr ? mgr.carCommissionRate || 0 : 0, basePay,
    tipsTotal, tipDetails,
    totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
    jobs: relevant.map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName,
      upsells: myUpsells(s).map((u) => ({ name: u.name, price: u.price })),
    })).sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

// ---------- sales rep — read-only view of their own bookings. Commission depends on the
// manager's arrived/no-show mark, so a sales rep can never touch status themselves; this
// role only has GET routes, no PATCH access to anything. ----------
// One place that decides which of a rep's two rates applies to a given sale, based on
// exactly when it closed — used everywhere commission gets calculated, so the rule can
// never drift out of sync between the rep's own dashboard, the owner dashboard, and payroll.
function salesRepCommissionForSale(rep, sale) {
  if (!rep || sale.status !== "arrived") return { amount: 0, duringHours: null };
  const duringHours = isDuringBusinessHours(sale.closedAt || sale.date);
  const rate = duringHours ? (rep.commissionRate || 0) : (rep.afterHoursCommissionRate || 0);
  return { amount: (parseFloat(sale.basePrice) || 0) * (rate / 100), duringHours };
}
// Walk-in closer commission — a DIFFERENT rule than sales reps. This requires the job to
// be both arrived AND marked paid, not just arrived. It's on the base price, only for
// whoever is recorded as having personally closed that specific walk-in.
function walkInCommissionForSale(person, sale) {
  if (!person || !sale.isWalkIn || sale.status !== "arrived" || !sale.paid) return 0;
  const rate = person.walkInCommissionRate || 0;
  return (parseFloat(sale.basePrice) || 0) * (rate / 100);
}

app.get("/api/my/sales-schedule", requireSales, (req, res) => {
  const db = loadDB();
  const repId = req.auth.role === "owner" && req.query.salesRepId ? req.query.salesRepId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales
    .filter((s) => s.salesRepId === repId && inRange(s.date, start, end))
    .map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName, baseService: s.baseService,
      basePrice: s.basePrice, status: s.status || "pending", notes: s.notes || [],
      upsells: resolveUpsellNames(s.upsells || [], db),
      // No price/status editing here — this is a read-only view of what THEY sold and whether it showed.
    }));
  res.json(jobs);
});

// The full shop schedule — every job, not just their own bookings. No price shown, same
// privacy rule as employees. Read-only: sales reps can see arrival/completion status,
// never set it.
app.get("/api/sales/full-schedule", requireSales, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales.filter((s) => inRange(s.date, start, end)).map((s) => ({
    id: s.id, date: s.date, car: s.car, baseService: s.baseService,
    employeeNames: s.employeeNames || "Unassigned",
    status: s.status || "pending", completed: !!s.completed, notes: s.notes || [],
    upsells: resolveUpsellNames(s.upsells || [], db),
  }));
  res.json(jobs);
});

// Owner-wide commission audit — every appointment attributed to any sales rep, regardless
// of status (pending, arrived, no-show), with exactly when it closed and why it got the
// rate it did. This is the full-system version of the per-rep audit trail below.
app.get("/api/owner/commission-audit", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  // Must match Payroll's own filtering exactly (excludingCancelled + the revenue start
  // date cutoff) - otherwise these two pages can silently disagree on the same numbers,
  // specifically when a revenue start date has been set to exclude old pre-tracking jobs.
  const relevant = revenueEligible(db.sales.filter((s) => s.salesRepId && inRange(s.date, start, end)), db);
  const rows = relevant.map((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    const closedAtRaw = s.closedAt || s.date;
    const closedDate = new Date(closedAtRaw);
    const easternLabel = isNaN(closedDate.getTime()) ? "unknown" : closedDate.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const duringHours = isDuringBusinessHours(closedAtRaw);
    const rateApplied = duringHours ? (rep ? rep.commissionRate || 0 : 0) : (rep ? rep.afterHoursCommissionRate || 0 : 0);
    // Projected, not actual — this section answers "if every appointment currently
    // scheduled in this period shows up as planned, what's the commission total," which is
    // a genuinely different question from Payroll's number (actual commission owed, only
    // counting jobs that have actually arrived so far). A no-show or reschedule will change
    // this from what actually gets paid out - that's expected, not a bug.
    const commissionAmount = rep ? (parseFloat(s.basePrice) || 0) * (rateApplied / 100) : 0;
    return {
      saleId: s.id, car: s.car, customerName: s.customerName, basePrice: parseFloat(s.basePrice) || 0,
      salesRepName: rep ? rep.name : "Removed rep", status: s.status || "pending",
      closedAtRaw, closedAtEastern: easternLabel, duringHours, rateApplied, commissionAmount,
    };
  }).sort((a, b) => (a.closedAtRaw < b.closedAtRaw ? 1 : -1));
  res.json(rows);
});

// Closing activity — how much a sales rep actually CLOSED on a given day or week,
// regardless of what day the appointment is scheduled for. This is a genuinely different
// question than the audit above (which tracks appointments happening within a date range,
// and only counts commission once the customer actually shows). A deal closed today might
// be scheduled two weeks out — this measures the calling activity itself, showing what
// that activity is worth in projected commission if it holds, not what's been earned yet.
app.get("/api/owner/closing-activity", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const relevant = revenueEligible(db.sales.filter((s) => s.salesRepId && inRange(s.closedAt || s.date, start, end)), db);
  const byRep = {};
  relevant.forEach((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    const repName = rep ? rep.name : "Removed rep";
    if (!byRep[repName]) byRep[repName] = { name: repName, closeCount: 0, projectedCommission: 0, totalValue: 0, arrivedCount: 0, pendingCount: 0, noShowCount: 0, closes: [] };
    const duringHours = isDuringBusinessHours(s.closedAt || s.date);
    const rate = rep ? (duringHours ? (rep.commissionRate || 0) : (rep.afterHoursCommissionRate || 0)) : 0;
    const basePrice = parseFloat(s.basePrice) || 0;
    const projectedAmount = basePrice * (rate / 100);
    byRep[repName].closeCount += 1;
    byRep[repName].totalValue += basePrice;
    byRep[repName].projectedCommission += projectedAmount;
    if (s.status === "arrived") byRep[repName].arrivedCount += 1;
    else if (s.status === "no_show") byRep[repName].noShowCount += 1;
    else byRep[repName].pendingCount += 1;
    // Individual close detail - so a $0 value is immediately visible and traceable back
    // to a specific job that just needs its price filled in via Cleanup.
    byRep[repName].closes.push({
      saleId: s.id, car: s.car, customerName: s.customerName, date: s.date, closedAt: s.closedAt || s.date,
      basePrice, projectedCommission: projectedAmount, status: s.status || "pending", missingPrice: !s.basePrice,
    });
  });
  const perRep = Object.values(byRep).sort((a, b) => b.closeCount - a.closeCount);
  perRep.forEach((r) => r.closes.sort((a, b) => (a.date < b.date ? 1 : -1)));
  res.json({
    totalCloses: relevant.length,
    totalProjectedCommission: perRep.reduce((a, r) => a + r.projectedCommission, 0),
    totalValue: perRep.reduce((a, r) => a + r.totalValue, 0),
    perRep,
  });
});

app.get("/api/my/sales-performance", requireSales, (req, res) => {
  const db = loadDB();
  const repId = req.auth.role === "owner" && req.query.salesRepId ? req.query.salesRepId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const rep = db.salesReps.find((r) => r.id === repId);
  const mine = db.sales.filter((s) => s.salesRepId === repId && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));

  const totalBooked = mine.length;
  const totalBookedValue = mine.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const showed = mine.filter((s) => s.status === "arrived");
  const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const noShowCount = mine.filter((s) => s.status === "no_show").length;
  const pending = mine.filter((s) => !s.status || s.status === "pending");
  const pendingCount = pending.length;
  const pendingValue = pending.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);

  let commission = 0, duringHoursValue = 0, afterHoursValue = 0, duringHoursCount = 0, afterHoursCount = 0;
  const commissionAudit = [];
  showed.forEach((s) => {
    const c = salesRepCommissionForSale(rep, s);
    commission += c.amount;
    if (c.duringHours) { duringHoursValue += parseFloat(s.basePrice) || 0; duringHoursCount += 1; }
    else { afterHoursValue += parseFloat(s.basePrice) || 0; afterHoursCount += 1; }
    // A real, per-job audit line — exactly when it closed, which bucket it landed in, and
    // why — so nobody ever has to manually reconstruct this by hand.
    const closedAtRaw = s.closedAt || s.date;
    const closedDate = new Date(closedAtRaw);
    const easternLabel = isNaN(closedDate.getTime()) ? "unknown" : closedDate.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    commissionAudit.push({
      saleId: s.id, car: s.car, basePrice: parseFloat(s.basePrice) || 0,
      closedAtRaw, closedAtEastern: easternLabel,
      duringHours: c.duringHours, rateApplied: c.duringHours ? (rep ? rep.commissionRate || 0 : 0) : (rep ? rep.afterHoursCommissionRate || 0 : 0),
      commissionAmount: c.amount,
    });
  });
  commissionAudit.sort((a, b) => (a.closedAtRaw < b.closedAtRaw ? 1 : -1));

  // Upsells this rep personally closed — tracked for visibility, e.g. a phone upsell on
  // someone else's booking. Separate from the base-sale commission above; shown, not
  // auto-paid, until a specific rate/rule for it is decided.
  const myUpsells = [];
  db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db)).forEach((s) => {
    (s.upsells || []).forEach((u) => { if (u.salesRepId === repId) myUpsells.push({ id: u.id, name: u.name, price: u.price, car: s.car, date: s.date, saleId: s.id }); });
  });
  const upsellsClosedValue = myUpsells.reduce((a, u) => a + (parseFloat(u.price) || 0), 0);

  res.json({
    totalBooked, totalBookedValue, showedCount: showed.length, showedValue,
    noShowCount, pendingCount, pendingValue, commission,
    commissionRate: rep ? rep.commissionRate || 0 : 0,
    afterHoursCommissionRate: rep ? rep.afterHoursCommissionRate || 0 : 0,
    duringHoursCount, duringHoursValue, afterHoursCount, afterHoursValue,
    upsellsClosedCount: myUpsells.length, upsellsClosedValue, upsellsClosed: myUpsells,
    commissionAudit,
  });
});

// ---------- contact/vehicle search — find a job by customer name, phone, email, or car ----------
app.get("/api/manager/search", requireManager, (req, res) => {
  const db = loadDB();
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  const results = db.sales.filter((s) =>
    (s.customerName || "").toLowerCase().includes(q) ||
    (s.customerPhone || "").toLowerCase().includes(q) ||
    (s.customerEmail || "").toLowerCase().includes(q) ||
    (s.car || "").toLowerCase().includes(q) ||
    (s.employeeNames || "").toLowerCase().includes(q)
  );
  res.json(results
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 50)
    .map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName,
      customerPhone: s.customerPhone, customerEmail: s.customerEmail,
      employeeNames: s.employeeNames, managerHelperNames: s.managerHelperNames || "", baseService: s.baseService,
      basePrice: s.basePrice || 0, total: saleTotal(s), status: s.status, completed: !!s.completed, paid: !!s.paid, paymentMethod: s.paymentMethod || null,
      salesRepName: s.salesRepName || null, isWalkIn: !!s.isWalkIn, isOnlineBooking: !!s.isOnlineBooking,
      upsells: resolveUpsellNames(s.upsells, db), notes: s.notes || [], photos: s.photos || { before: {}, after: {} },
    }))
  );
});

// ---------- owner-only: everything ----------
app.get("/api/owner/sales", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end));
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db) })));
});

// Serviced Cars — only jobs actually marked Service Complete, regardless of payment status.
// This is the "work actually done" view, distinct from the schedule/booking pipeline.
app.get("/api/owner/serviced-cars", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end) && s.completed && s.status !== "cancelled");
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db) })));
});

// A genuinely separate question from Serviced Cars - a car can arrive without the work
// being finished yet, so this counts by arrival, not completion.
app.get("/api/owner/cars-arrived", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end) && s.status === "arrived");
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db) })));
});

// Payroll view — every person's own upsells grouped together (for paying commission),
// plus the shop-wide combined total for comparison. Owner-only.
// Base pay — salary or hourly, reduced for absences and half days. A full pay period
// is assumed to be 12 workdays (Mon-Sat x 2 weeks), so a salaried person's daily rate is
// their period salary divided by 12. An hourly person without specific start/end times
// entered for a given day (just a normal day, nothing unusual) is assumed to have worked
// a standard 9-hour day, matching this shop's actual business hours (8am-6pm minus a
// lunch hour) - real times entered for that day always override this assumption.
const FULL_PERIOD_WORKDAYS = 12;
const DEFAULT_HOURLY_DAY_HOURS = 9;
function timeStringToHours(t) {
  if (!t) return null;
  const parts = String(t).split(":");
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h + m / 60;
}
// "End of day Eastern" converted to UTC can land in the next UTC calendar day (e.g.
// 11:59:59pm Eastern is already past 3am UTC the next day) — slicing that ISO string
// directly would silently pull in one extra day at the end of every attendance range.
// Pulling back a safe margin before slicing corrects it to the actual intended last day.
function endDateStringFor(endIso) {
  return new Date(new Date(endIso).getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function calculateBasePay(person, attendanceRecords, sales) {
  if (!person.payType) return { amount: 0, daysPresent: 0, daysHalf: 0, daysAbsent: 0, hoursCounted: 0, dailyRate: 0, configured: false, carDetails: [] };
  if (person.payType === "salary") {
    const dailyRate = (person.salaryPerPeriod || 0) / FULL_PERIOD_WORKDAYS;
    let amount = 0, daysPresent = 0, daysHalf = 0, daysAbsent = 0;
    attendanceRecords.forEach((a) => {
      if (a.status === "present") { amount += dailyRate; daysPresent++; }
      else if (a.status === "half_day") { amount += dailyRate / 2; daysHalf++; }
      else if (a.status === "absent") { daysAbsent++; }
    });
    return { amount, daysPresent, daysHalf, daysAbsent, hoursCounted: 0, dailyRate, configured: true, carDetails: [] };
  }
  if (person.payType === "commission") {
    // A % of the car's base price, split evenly among everyone who worked it - techs
    // (employeeIds) and any manager who helped hands-on (managerHelperIds) both count,
    // both toward the split total and toward their own share. Same split math as tips,
    // just automatic and tied to the job's price instead of a manually entered amount.
    // Only counts once a car has actually arrived and been paid, same rule walk-in
    // commission already uses, so this reflects money actually collected.
    const allWorkers = (s) => [...(saleEmployeeIds(s) || []), ...(s.managerHelperIds || [])];
    const myCars = (sales || []).filter((s) => allWorkers(s).includes(person.id) && s.status === "arrived" && s.paid);
    let amount = 0;
    const carDetails = myCars.map((s) => {
      const splitCount = allWorkers(s).length;
      const basePrice = parseFloat(s.basePrice) || 0;
      const share = Math.round((basePrice * (person.carCommissionRate || 0) / 100 / splitCount) * 100) / 100;
      amount += share;
      return { id: s.id, car: s.car, basePrice, splitCount, yourShare: share };
    });
    return { amount, daysPresent: 0, daysHalf: 0, daysAbsent: 0, hoursCounted: 0, dailyRate: 0, configured: true, carDetails };
  }
  // hourly
  let amount = 0, hoursCounted = 0, daysPresent = 0, daysHalf = 0, daysAbsent = 0;
  attendanceRecords.forEach((a) => {
    if (a.status === "absent") { daysAbsent++; return; }
    if (!a.status) return;
    const startH = timeStringToHours(a.startTime), endH = timeStringToHours(a.endTime);
    let hours;
    if (startH !== null && endH !== null && endH > startH) hours = endH - startH;
    else hours = a.status === "half_day" ? DEFAULT_HOURLY_DAY_HOURS / 2 : DEFAULT_HOURLY_DAY_HOURS;
    amount += hours * (person.hourlyRate || 0);
    hoursCounted += hours;
    if (a.status === "half_day") daysHalf++; else daysPresent++;
  });
  return { amount, daysPresent, daysHalf, daysAbsent, hoursCounted, dailyRate: 0, configured: true, carDetails: [] };
}

app.get("/api/owner/payroll", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = revenueEligible(db.sales.filter((s) => inRange(s.date, start, end)), db);
  const shopTotalUpsellRevenue = sales.reduce((a, s) => a + saleUpsellTotal(s), 0);
  const duplicateSaleIds = findDuplicateSaleIds(sales);

  function personBreakdown(idField, id) {
    const mine = [];
    sales.forEach((s) => (s.upsells || []).forEach((u) => { if (u[idField] === id) mine.push({ ...u, saleId: s.id, car: s.car, date: s.date }); }));
    const revenue = mine.reduce((a, u) => a + (parseFloat(u.price) || 0), 0);
    const grouped = {};
    mine.forEach((u) => {
      const k = u.name.trim();
      grouped[k] = grouped[k] || { name: k, count: 0, revenue: 0 };
      grouped[k].count += 1;
      grouped[k].revenue += parseFloat(u.price) || 0;
    });
    return {
      revenue, count: mine.length, items: Object.values(grouped).sort((a, b) => b.revenue - a.revenue),
      individual: mine.slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }

  const employees = db.employees.map((emp) => {
    const b = personBreakdown("employeeId", emp.id);
    const carsWorked = sales.filter((s) => saleEmployeeIds(s).includes(emp.id)).length;
    const commission = emp.commissionRate ? b.revenue * (emp.commissionRate / 100) : 0;
    // Walk-ins this tech personally closed — a separate pay source from upsell commission,
    // only counted once a job is BOTH arrived and paid. This was missing from Payroll
    // even though it already worked correctly on the tech's own performance page.
    const myWalkIns = sales.filter((s) => s.walkInClosedByType === "employee" && s.walkInClosedById === emp.id);
    const walkInClosedCount = myWalkIns.length;
    const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(emp, s), 0);
    // Individual walk-in details - same drill-down pattern already used for upsells and
    // sales rep arrivals, so a tech's walk-in total isn't just an opaque aggregate.
    const walkInDetails = myWalkIns.map((s) => ({
      id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0,
      status: s.status || "pending", paid: !!s.paid, commissionAmount: walkInCommissionForSale(emp, s),
    }));
    const myAttendance = db.attendance.filter((a) => a.personType === "employee" && a.personId === emp.id && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
    const basePay = calculateBasePay(emp, myAttendance, sales);
    // Tips - matched to whichever pay period the JOB happened in, not when the tip was
    // logged, so this stays consistent with how every other number on this page works.
    const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "employee" && sp.personId === emp.id));
    const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "employee" && sp.personId === emp.id).amount, 0);
    const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "employee" && sp.personId === emp.id).amount, splitCount: t.split.length }));
    return {
      id: emp.id, name: emp.name, commissionRate: emp.commissionRate || 0, carsWorked, upsellRevenue: b.revenue, upsellCount: b.count, commission, upsells: b.items, individualUpsells: b.individual,
      walkInCommissionRate: emp.walkInCommissionRate || 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue, walkInDetails,
      payType: emp.payType || null, salaryPerPeriod: emp.salaryPerPeriod || 0, hourlyRate: emp.hourlyRate || 0, carCommissionRate: emp.carCommissionRate || 0, basePay,
      tipsTotal, tipDetails,
      totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
    };
  });
  const managers = db.managers.map((mgr) => {
    const b = personBreakdown("managerId", mgr.id);
    const commission = mgr.commissionRate ? b.revenue * (mgr.commissionRate / 100) : 0;
    const myWalkIns = sales.filter((s) => s.walkInClosedByType === "manager" && s.walkInClosedById === mgr.id);
    const walkInClosedCount = myWalkIns.length;
    const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(mgr, s), 0);
    const walkInDetails = myWalkIns.map((s) => ({
      id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0,
      status: s.status || "pending", paid: !!s.paid, commissionAmount: walkInCommissionForSale(mgr, s),
    }));
    const myAttendance = db.attendance.filter((a) => a.personType === "manager" && a.personId === mgr.id && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
    const basePay = calculateBasePay(mgr, myAttendance, sales);
    const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "manager" && sp.personId === mgr.id));
    const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "manager" && sp.personId === mgr.id).amount, 0);
    const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "manager" && sp.personId === mgr.id).amount, splitCount: t.split.length }));
    return {
      id: mgr.id, name: mgr.name, commissionRate: mgr.commissionRate || 0, upsellRevenue: b.revenue, upsellCount: b.count, commission, upsells: b.items, individualUpsells: b.individual,
      walkInCommissionRate: mgr.walkInCommissionRate || 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue, walkInDetails,
      payType: mgr.payType || null, salaryPerPeriod: mgr.salaryPerPeriod || 0, hourlyRate: mgr.hourlyRate || 0, carCommissionRate: mgr.carCommissionRate || 0, basePay,
      tipsTotal, tipDetails,
      totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
    };
  });
  // Sales reps are a different pay structure entirely — commission on the base sale, only
  // when the manager marked it arrived. Not tied to upsells at all.
  const salesReps = db.salesReps.map((rep) => {
    const mine = sales.filter((s) => s.salesRepId === rep.id);
    const showed = mine.filter((s) => s.status === "arrived");
    const noShow = mine.filter((s) => s.status === "no_show");
    const resolved = showed.length + noShow.length; // excludes still-pending future bookings
    const noShowRate = resolved > 0 ? (noShow.length / resolved) * 100 : 0;
    const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    let commission = 0, duringHoursCount = 0, afterHoursCount = 0;
    const duplicateWarnings = [];
    showed.forEach((s) => {
      const c = salesRepCommissionForSale(rep, s);
      commission += c.amount;
      if (c.duringHours) duringHoursCount += 1; else afterHoursCount += 1;
      if (duplicateSaleIds.has(s.id)) duplicateWarnings.push({ id: s.id, car: s.car, date: s.date, basePrice: s.basePrice, commissionAmount: c.amount });
    });
    // Individual arrived/no-show details - lets Payroll show a real drill-down instead of
    // just the aggregate counts, so you can see exactly which cars are behind each number.
    const arrivedDetails = showed.map((s) => ({ id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0, commissionAmount: salesRepCommissionForSale(rep, s).amount }));
    const noShowDetails = noShow.map((s) => ({ id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0 }));
    return { id: rep.id, name: rep.name, commissionRate: rep.commissionRate || 0, afterHoursCommissionRate: rep.afterHoursCommissionRate || 0, totalBooked: mine.length, showedCount: showed.length, showedValue, duringHoursCount, afterHoursCount, commission, noShowCount: noShow.length, noShowRate, duplicateWarnings, arrivedDetails, noShowDetails };
  });

  res.json({ shopTotalUpsellRevenue, employees, managers, salesReps });
});

// Full raw backup — everyone's data, as a downloadable file the owner can save anywhere
// (their own computer, Google Drive, wherever) independent of Railway entirely.
// Checks whether the GHL import actually created duplicate jobs, or whether the running
// "imported" counter just double-counted re-processed records without creating duplicates
// (the counter increments on every upsert call, including ones that update an existing
// job rather than creating a new one — so the counter can honestly exceed the real total).
// Real audit trail for price, service, and sales rep changes - who changed what, when.
app.get("/api/owner/audit-log", requireOwner, (req, res) => {
  const db = loadDB();
  res.json((db.auditLog || []).slice(0, 200));
});

app.get("/api/owner/import-diagnostic", requireOwner, (req, res) => {
  const db = loadDB();
  const withOppId = db.sales.filter((s) => s.ghlOpportunityId);
  const idCounts = {};
  withOppId.forEach((s) => { idCounts[s.ghlOpportunityId] = (idCounts[s.ghlOpportunityId] || 0) + 1; });
  const duplicateIds = Object.entries(idCounts).filter(([id, count]) => count > 1);

  // Same real customer, multiple separate opportunities — a much stronger signal than
  // opportunity ID, and the one that actually catches "duplicate-looking" jobs that are
  // genuinely different GHL records (e.g. left over from testing appointment status
  // toggles before the bulk import existed).
  const withContactId = db.sales.filter((s) => s.contactId && s.status !== "cancelled");
  const byContact = {};
  withContactId.forEach((s) => { (byContact[s.contactId] = byContact[s.contactId] || []).push(s); });
  const contactDuplicates = Object.entries(byContact)
    .filter(([id, group]) => group.length > 1)
    .map(([contactId, group]) => ({
      contactId, count: group.length,
      jobs: group.map((s) => ({ id: s.id, car: s.car, date: s.date, customerName: s.customerName, basePrice: s.basePrice, ghlOpportunityId: s.ghlOpportunityId })),
    }));

  // Jobs missing the very IDs the checks above rely on — if a webhook event (like a
  // reschedule) doesn't include these, duplicates from it are invisible to every check
  // above, since there's nothing shared to match them by.
  const activeSales = db.sales.filter((s) => s.status !== "cancelled");
  const missingOppId = activeSales.filter((s) => !s.ghlOpportunityId);
  const missingContactId = activeSales.filter((s) => !s.contactId);

  // Fallback: same customer name + same calendar day, regardless of whether ghlOpportunityId
  // or contactId are present at all — catches duplicates the ID-based checks structurally
  // cannot see.
  const byNameAndDay = {};
  activeSales.forEach((s) => {
    if (!s.customerName || !s.date) return;
    const key = `${s.customerName.trim().toLowerCase()}|${s.date.slice(0, 10)}`;
    (byNameAndDay[key] = byNameAndDay[key] || []).push(s);
  });
  const nameAndDayDuplicates = Object.entries(byNameAndDay)
    .filter(([key, group]) => group.length > 1)
    .map(([key, group]) => ({
      customerName: group[0].customerName, date: group[0].date.slice(0, 10), count: group.length,
      jobs: group.map((s) => ({ id: s.id, car: s.car, date: s.date, basePrice: s.basePrice, ghlOpportunityId: s.ghlOpportunityId || null, contactId: s.contactId || null })),
    }));

  // Broader net: same customer name, ANY date — catches a reschedule that moved someone
  // to a completely different day, which the same-day check above structurally can't see.
  // Wider net means real risk of a genuine repeat customer showing up here too — needs a
  // human eye, not an auto-fix.
  const byNameOnly = {};
  activeSales.forEach((s) => {
    if (!s.customerName) return;
    const key = s.customerName.trim().toLowerCase();
    (byNameOnly[key] = byNameOnly[key] || []).push(s);
  });
  const nameOnlyDuplicates = Object.entries(byNameOnly)
    .filter(([key, group]) => group.length > 1)
    .map(([key, group]) => ({
      customerName: group[0].customerName, count: group.length,
      jobs: group.map((s) => ({ id: s.id, car: s.car, date: s.date, basePrice: s.basePrice, ghlOpportunityId: s.ghlOpportunityId || null, contactId: s.contactId || null })),
    }));

  res.json({
    totalSalesInDatabase: db.sales.length,
    salesWithGhlOpportunityId: withOppId.length,
    uniqueOpportunityIds: Object.keys(idCounts).length,
    duplicateOpportunityIds: duplicateIds.length,
    duplicateExamples: duplicateIds.slice(0, 5).map(([id, count]) => ({ ghlOpportunityId: id, count })),
    contactsWithMultipleJobs: contactDuplicates.length,
    contactDuplicates: contactDuplicates.slice(0, 20),
    missingOppIdCount: missingOppId.length,
    missingContactIdCount: missingContactId.length,
    nameAndDayDuplicateGroups: nameAndDayDuplicates.length,
    nameAndDayDuplicates: nameAndDayDuplicates.slice(0, 20),
    nameOnlyDuplicateGroups: nameOnlyDuplicates.length,
    nameOnlyDuplicates: nameOnlyDuplicates.slice(0, 30),
  });
});

// One-click cleanup: for every customer with multiple separate jobs, keep whichever one
// has the most recent date and delete the rest. Dry run shows exactly what would happen
// before anything is touched — worth a quick skim, but not a per-group manual review.
app.post("/api/owner/dedupe-contacts", requireOwner, (req, res) => {
  const db = loadDB();
  const dryRun = !!req.body.dryRun;
  const withContactId = db.sales.filter((s) => s.contactId && s.status !== "cancelled");
  const byContact = {};
  withContactId.forEach((s) => { (byContact[s.contactId] = byContact[s.contactId] || []).push(s); });

  const plan = [];
  Object.values(byContact).forEach((group) => {
    if (group.length < 2) return;
    // Prefer whichever record actually has a real price — a $0 duplicate is almost always
    // a stale/incomplete GHL record, not the real booking, regardless of which one happens
    // to have the most recent date.
    const sorted = group.slice().sort((a, b) => {
      const aPriced = (parseFloat(a.basePrice) || 0) > 0;
      const bPriced = (parseFloat(b.basePrice) || 0) > 0;
      if (aPriced !== bPriced) return aPriced ? -1 : 1;
      return a.date < b.date ? 1 : -1;
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    plan.push({
      keep: { id: keep.id, car: keep.car, date: keep.date, customerName: keep.customerName, basePrice: keep.basePrice },
      remove: remove.map((s) => ({ id: s.id, car: s.car, date: s.date, customerName: s.customerName, basePrice: s.basePrice })),
    });
  });

  if (!dryRun) {
    const removeIds = new Set(plan.flatMap((p) => p.remove.map((r) => r.id)));
    db.sales = db.sales.filter((s) => !removeIds.has(s.id));
    saveDB(db);
  }

  res.json({ ok: true, dryRun, groupsAffected: plan.length, totalRemoved: plan.reduce((a, p) => a + p.remove.length, 0), plan: plan.slice(0, 30) });
});

app.get("/api/owner/backup", requireOwner, (req, res) => {
  const db = loadDB();
  const filename = `sbn-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(db, null, 2));
});

// Revenue tracking start date — the real fix. Nothing about any job's actual price ever
// changes. Instead, every job dated before this cutoff simply gets skipped when totaling
// revenue or commission anywhere in the app, while still showing up completely normally
// in All Jobs, Search, and the schedule with its real original price intact.
app.get("/api/owner/revenue-start-date", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ revenueStartDate: db.revenueStartDate || null });
});
app.post("/api/owner/revenue-start-date", requireOwner, (req, res) => {
  const db = loadDB();
  db.revenueStartDate = req.body.date || null;
  saveDB(db);
  res.json({ ok: true, revenueStartDate: db.revenueStartDate });
});

// ---------- automated cloud backup — runs on its own, no manual click required ----------
// Pushes a copy of the entire database to a private GitHub repo on a schedule. This is
// genuinely off-Railway, genuinely automatic, and genuinely durable — the actual answer
// to "if the site breaks, I don't want to lose anything." Requires GITHUB_BACKUP_TOKEN
// and GITHUB_BACKUP_REPO to be set as environment variables; if they're not set, this
// quietly does nothing rather than crashing the app.
const GITHUB_BACKUP_TOKEN = process.env.GITHUB_BACKUP_TOKEN || "";
const GITHUB_BACKUP_REPO = process.env.GITHUB_BACKUP_REPO || ""; // format: "yourusername/your-repo"
let lastCloudBackup = null;

async function runCloudBackup() {
  if (!GITHUB_BACKUP_TOKEN || !GITHUB_BACKUP_REPO) {
    lastCloudBackup = { time: new Date().toISOString(), ok: false, error: "Not configured — set GITHUB_BACKUP_TOKEN and GITHUB_BACKUP_REPO." };
    return lastCloudBackup;
  }
  try {
    const db = loadDB();
    const content = Buffer.from(JSON.stringify(db, null, 2)).toString("base64");
    const apiBase = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents`;
    const headers = {
      Authorization: `Bearer ${GITHUB_BACKUP_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    // Always-current backup — one file, overwritten every time, for a fast restore.
    let sha;
    try {
      const getRes = await fetch(`${apiBase}/backups/latest.json`, { headers });
      if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
    } catch (e) {}
    const putRes = await fetch(`${apiBase}/backups/latest.json`, {
      method: "PUT", headers,
      body: JSON.stringify({ message: `Backup ${new Date().toISOString()}`, content, sha }),
    });
    if (!putRes.ok) {
      const errBody = await putRes.text();
      lastCloudBackup = { time: new Date().toISOString(), ok: false, error: `GitHub returned ${putRes.status}: ${errBody.slice(0, 200)}` };
      return lastCloudBackup;
    }

    // Also keep one dated snapshot per day, so there's real history to fall back to.
    const today = new Date().toISOString().slice(0, 10);
    const snapshotPath = `backups/snapshots/${today}.json`;
    let snapshotExists = false;
    try {
      const checkRes = await fetch(`${apiBase}/${snapshotPath}`, { headers });
      snapshotExists = checkRes.ok;
    } catch (e) {}
    if (!snapshotExists) {
      await fetch(`${apiBase}/${snapshotPath}`, {
        method: "PUT", headers,
        body: JSON.stringify({ message: `Daily snapshot ${today}`, content }),
      });
    }

    lastCloudBackup = { time: new Date().toISOString(), ok: true };
  } catch (e) {
    lastCloudBackup = { time: new Date().toISOString(), ok: false, error: e.message };
  }
  return lastCloudBackup;
}

app.get("/api/owner/backup-status", requireOwner, (req, res) => {
  res.json({ configured: !!(GITHUB_BACKUP_TOKEN && GITHUB_BACKUP_REPO), last: lastCloudBackup });
});

app.post("/api/owner/backup-now", requireOwner, async (req, res) => {
  const result = await runCloudBackup();
  res.json(result);
});

// ---------- GHL API bulk import — Phase 1: diagnostic only ----------
// This does NOT import anything. Each of these makes one real, read-only API call to GHL
// and dumps the raw response into the debug log — building up a real picture of your
// account's data shape, piece by piece, before any import logic gets written.
const GHL_API_TOKEN = process.env.GHL_API_TOKEN || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// GHL never fires any event for a plain title edit after booking — there's no signal to
// listen for, so instead of waiting for one, this periodically asks GHL directly using
// the same API connection the bulk import uses. Runs on upcoming jobs only, within a
// reasonable near-term window, so it stays a light, bounded check rather than scanning
// your entire history every time.
async function runTitleSync() {
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) return { skipped: true, reason: "GHL API not configured on this deployment." };
  const db = loadDB();
  const now = new Date();
  const horizon = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000); // next 3 weeks
  const candidates = db.sales.filter((s) =>
    s.contactId && !["arrived", "no_show", "cancelled"].includes(s.status) &&
    !isNaN(new Date(s.date).getTime()) && new Date(s.date) >= now && new Date(s.date) <= horizon
  );
  let checked = 0, updated = 0;
  for (const sale of candidates) {
    try {
      const apptUrl = `https://services.leadconnectorhq.com/contacts/${sale.contactId}/appointments`;
      const apptRes = await fetch(apptUrl, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
      const apptBody = await apptRes.json().catch(() => null);
      const events = (apptBody && apptBody.events) || [];
      if (events.length === 0) continue;
      const appt = events.slice().sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))[0];
      checked++;
      if (appt.title && appt.title.trim() && appt.title.trim() !== sale.car) {
        const before = sale.car;
        sale.car = appt.title.trim();
        if (!db.auditLog) db.auditLog = [];
        db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto-sync (GHL)", saleId: sale.id, car: sale.car, field: "Car/Title", oldValue: before, newValue: sale.car });
        db.auditLog = db.auditLog.slice(0, 1000);
        updated++;
      }
      await new Promise((r) => setTimeout(r, 200)); // same pacing as the bulk import - stays well under GHL's rate limits
    } catch (e) {
      // one bad lookup shouldn't stop the whole run - just skip it and keep going
    }
  }
  if (updated > 0) saveDB(db);
  return { skipped: false, candidateCount: candidates.length, checked, updated };
}

app.post("/api/owner/title-sync-now", requireOwner, async (req, res) => {
  const result = await runTitleSync();
  res.json({ ok: true, ...result });
});

async function ghlTestCall(db, label, url) {
  if (!db.debugLog) db.debugLog = [];
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) {
    return { error: "GHL_API_TOKEN and GHL_LOCATION_ID must be set as environment variables first." };
  }
  try {
    const ghlRes = await fetch(url, {
      headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    });
    const bodyText = await ghlRes.text();
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch (e) { parsed = bodyText; }
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: label, requestUrl: url, responseStatus: ghlRes.status, responseBody: parsed });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return { ok: true, status: ghlRes.status };
  } catch (e) {
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: label, error: e.message });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return { error: e.message };
  }
}

app.post("/api/owner/ghl-import-test", requireOwner, async (req, res) => {
  const db = loadDB();
  const r = await ghlTestCall(db, "ghl-import-test", `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=5`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the Webhook Debug Log to see the full raw response." });
});

// Test 2 — get the real pipeline stage names, so we can identify which stage ID means
// "Booked w/ Deposit" (the search results showed IDs, not names).
app.post("/api/owner/ghl-test-pipelines", requireOwner, async (req, res) => {
  const db = loadDB();
  const r = await ghlTestCall(db, "ghl-test-pipelines", `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log for pipeline stage names and IDs." });
});

// Test 2b — now that we know the real "Booked W Deposit" stage ID, pull opportunities
// filtered specifically to that stage, instead of just the most recent leads overall.
app.post("/api/owner/ghl-test-booked-stage", requireOwner, async (req, res) => {
  const db = loadDB();
  const stageId = req.body.stageId;
  if (!stageId) return res.status(400).json({ error: "stageId is required." });
  const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_stage_id=${stageId}&limit=5`;
  const r = await ghlTestCall(db, "ghl-test-booked-stage", url);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log — this should show real booked jobs, hopefully with a real assignedTo value this time." });
});

// Test 3 — look up one specific contact directly, to check whether their assigned
// "Owner" (sales rep) shows up at the contact level, since it wasn't in the opportunity data.
app.post("/api/owner/ghl-test-contact", requireOwner, async (req, res) => {
  const db = loadDB();
  const contactId = req.body.contactId;
  if (!contactId) return res.status(400).json({ error: "contactId is required." });
  const r = await ghlTestCall(db, "ghl-test-contact", `https://services.leadconnectorhq.com/contacts/${contactId}`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log for the contact's real field names, especially anything like 'assignedTo' or 'owner'." });
});

// Test 4 — pull calendar/appointment data for one contact, since that's where the car
// (appointment title) and real service date/time actually live.
app.post("/api/owner/ghl-test-appointments", requireOwner, async (req, res) => {
  const db = loadDB();
  const contactId = req.body.contactId;
  if (!contactId) return res.status(400).json({ error: "contactId is required." });
  const r = await ghlTestCall(db, "ghl-test-appointments", `https://services.leadconnectorhq.com/contacts/${contactId}/appointments`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log for the appointment title (car) and real date/time." });
});

// Test 5 — the appointment's assignedUserId is just a random-looking ID, not a name.
// This resolves it into the actual person's real name, so we can match it against your
// registered sales reps/managers/techs the same way the webhook flow already does.
app.post("/api/owner/ghl-test-user", requireOwner, async (req, res) => {
  const db = loadDB();
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: "userId is required." });
  const r = await ghlTestCall(db, "ghl-test-user", `https://services.leadconnectorhq.com/users/${userId}`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log — looking for firstName/lastName or a name field." });
});

// The title text itself usually names the service — a low-risk way to fill this in using
// data we already have, rather than guessing from an unconfirmed calendar-ID mapping.
function guessServiceFromTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("ceramic")) return "Ceramic Coating";
  if (t.includes("tint")) return "Window Tint";
  if (t.includes("ppf")) return "PPF";
  return "";
}

// ---------- GHL bulk import — Phase 2: the real thing ----------
// Pulls opportunities from the "Booked W Deposit" stage, looks up each contact's actual
// appointment (car, real date), and imports using the exact same upsert logic as the live
// webhook flow — so re-running this is always safe, never creates duplicates. Runs in
// small batches with a resumable cursor rather than all at once, both to stay well under
// any request timeout and so a dry-run preview can be checked before anything is saved.
app.post("/api/owner/ghl-bulk-import", requireOwner, async (req, res) => {
  const db = loadDB();
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) {
    return res.status(400).json({ error: "GHL_API_TOKEN and GHL_LOCATION_ID must be set first." });
  }
  const stageId = req.body.stageId;
  const cutoffDate = req.body.cutoffDate || null; // "YYYY-MM-DD" — only import appointments on/after this
  const dryRun = !!req.body.dryRun;
  const batchSize = Math.min(parseInt(req.body.batchSize, 10) || 15, 25); // capped for safety
  if (!stageId) return res.status(400).json({ error: "stageId is required." });

  if (db.ghlImportCursor === undefined) db.ghlImportCursor = null;
  if (db.ghlImportImportedCount === undefined) db.ghlImportImportedCount = 0;

  const baseUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_stage_id=${stageId}&limit=${batchSize}`;
  const url = db.ghlImportCursor || baseUrl;

  let searchRes, searchBody;
  try {
    searchRes = await fetch(url, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
    searchBody = await searchRes.json();
  } catch (e) {
    return res.status(500).json({ error: "Failed to reach GHL: " + e.message });
  }
  if (!searchRes.ok) {
    if (!db.debugLog) db.debugLog = [];
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "ghl-bulk-import", requestUrl: url, responseStatus: searchRes.status, responseBody: searchBody });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.status(400).json({ error: `GHL returned ${searchRes.status} — check the Webhook Debug Log for the exact reason.`, detail: searchBody });
  }

  const opportunities = searchBody.opportunities || [];
  const results = { processed: 0, imported: 0, skippedOld: 0, skippedNoAppointment: 0, errors: [] };
  const preview = [];

  for (const opp of opportunities) {
    results.processed++;
    try {
      const apptUrl = `https://services.leadconnectorhq.com/contacts/${opp.contactId}/appointments`;
      const apptRes = await fetch(apptUrl, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
      const apptBody = await apptRes.json().catch(() => null);
      const events = (apptBody && apptBody.events) || [];
      if (events.length === 0) { results.skippedNoAppointment++; continue; }
      // If a contact has multiple appointments, the most recently created one is usually
      // the one tied to this specific deposit.
      const appt = events.slice().sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))[0];
      const normalizedDate = normalizeDate(appt.startTime);
      if (cutoffDate && normalizedDate && normalizedDate.slice(0, 10) < cutoffDate) { results.skippedOld++; continue; }

      const contact = opp.contact || {};
      // The real "closed" moment — when GHL's opportunity actually moved to Won — not
      // whenever this import happened to run. Without this, every bulk-imported job's
      // business-hours classification was silently based on the import's run time.
      const realClosedAt = opp.lastStatusChangeAt || opp.createdAt || null;
      // Which calendar this came through is a far more reliable signal than the title text
      // for what service this actually is — a genuine online booking's title is often just
      // the customer's name, with no service keyword to guess from at all, but the calendar
      // itself is unambiguous.
      const calendarService = (db.calendarServiceMap || {})[appt.calendarId];
      const record = {
        ghlOpportunityId: opp.id, contactId: opp.contactId,
        car: appt.title || "", date: appt.startTime, basePrice: opp.monetaryValue,
        customerName: contact.name || "", customerPhone: contact.phone || "", customerEmail: contact.email || "",
        baseService: calendarService || guessServiceFromTitle(appt.title), closedAt: realClosedAt,
        calendarId: appt.calendarId || null,
      };
      if (dryRun) preview.push(record);
      else { upsertSaleFromGHL(db, record); results.imported++; }
      // Small pacing delay between per-contact lookups — stays well under GHL's rate limits.
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      results.errors.push({ opportunityId: opp.id, error: e.message });
    }
  }

  if (!dryRun) {
    // Use GHL's own complete next-page URL as-is, rather than reconstructing pagination
    // params by hand — that reconstruction was the actual cause of the 422 error.
    db.ghlImportCursor = (searchBody.meta && searchBody.meta.nextPageUrl) ? searchBody.meta.nextPageUrl : null;
    db.ghlImportImportedCount = (db.ghlImportImportedCount || 0) + results.imported;
    saveDB(db);
  }

  res.json({
    ok: true, dryRun, ...results, preview: dryRun ? preview : undefined,
    hasMore: !!(searchBody.meta && searchBody.meta.nextPageUrl) && opportunities.length > 0,
    totalAvailable: searchBody.meta ? searchBody.meta.total : null,
    totalImportedSoFar: db.ghlImportImportedCount || 0,
  });
});

// Repairs the real closing timestamp on jobs already sitting in the tracker from a
// previous import that ran before this fix existed. Uses its OWN separate progress
// cursor from the main import, so running one never interferes with the other. Only
// touches closedAt — price, status, attribution, everything else stays exactly as-is.
app.post("/api/owner/ghl-repair-closedat", requireOwner, async (req, res) => {
  const db = loadDB();
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) {
    return res.status(400).json({ error: "GHL_API_TOKEN and GHL_LOCATION_ID must be set first." });
  }
  const stageId = req.body.stageId;
  const dryRun = !!req.body.dryRun;
  const batchSize = Math.min(parseInt(req.body.batchSize, 10) || 15, 25);
  if (!stageId) return res.status(400).json({ error: "stageId is required." });

  if (db.ghlRepairCursor === undefined) db.ghlRepairCursor = null;
  if (db.ghlRepairFixedCount === undefined) db.ghlRepairFixedCount = 0;

  const baseUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_stage_id=${stageId}&limit=${batchSize}`;
  const url = db.ghlRepairCursor || baseUrl;

  let searchRes, searchBody;
  try {
    searchRes = await fetch(url, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
    searchBody = await searchRes.json();
  } catch (e) {
    return res.status(500).json({ error: "Failed to reach GHL: " + e.message });
  }
  if (!searchRes.ok) return res.status(400).json({ error: `GHL returned ${searchRes.status}`, detail: searchBody });

  const opportunities = searchBody.opportunities || [];
  const results = { processed: 0, fixed: 0, noMatchingJob: 0, alreadyCorrect: 0, preview: [] };

  opportunities.forEach((opp) => {
    results.processed++;
    const sale = db.sales.find((s) => s.ghlOpportunityId === opp.id);
    if (!sale) { results.noMatchingJob++; return; }
    const correctClosedAt = opp.lastStatusChangeAt || opp.createdAt || null;
    if (!correctClosedAt) return;
    if (sale.closedAt === correctClosedAt) { results.alreadyCorrect++; return; }
    const before = sale.closedAt;
    if (dryRun) {
      results.preview.push({ car: sale.car, before, after: correctClosedAt });
    } else {
      sale.closedAt = correctClosedAt;
      results.fixed++;
    }
  });

  if (!dryRun) {
    db.ghlRepairCursor = (searchBody.meta && searchBody.meta.nextPageUrl) ? searchBody.meta.nextPageUrl : null;
    db.ghlRepairFixedCount = (db.ghlRepairFixedCount || 0) + results.fixed;
    saveDB(db);
  }

  res.json({
    ok: true, dryRun, ...results,
    hasMore: !!(searchBody.meta && searchBody.meta.nextPageUrl) && opportunities.length > 0,
    totalFixedSoFar: db.ghlRepairFixedCount || 0,
  });
});

app.get("/api/owner/ghl-repair-closedat-status", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ cursorSet: !!db.ghlRepairCursor, totalFixedSoFar: db.ghlRepairFixedCount || 0 });
});

app.post("/api/owner/ghl-repair-closedat-reset", requireOwner, (req, res) => {
  const db = loadDB();
  db.ghlRepairCursor = null;
  db.ghlRepairFixedCount = 0;
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/owner/ghl-bulk-import-status", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ cursorSet: !!db.ghlImportCursor, totalImportedSoFar: db.ghlImportImportedCount || 0 });
});

app.post("/api/owner/ghl-bulk-import-reset", requireOwner, (req, res) => {
  const db = loadDB();
  db.ghlImportCursor = null;
  db.ghlImportImportedCount = 0;
  saveDB(db);
  res.json({ ok: true });
});

function csvEscape(val) {
  const s = String(val === undefined || val === null ? "" : val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Spreadsheet export of every job in a period, ready to open in Excel/Sheets.
app.get("/api/owner/export/csv", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end));
  const headers = ["Date", "Car", "Customer", "Phone", "Email", "Base Service", "Worked By", "Base Price", "Upsell Total", "Total", "Status", "Completed", "Paid", "Payment Method", "Upsells (detail)"];
  const rows = sales.map((s) => {
    const upsells = resolveUpsellNames(s.upsells, db);
    const upsellDetail = upsells.map((u) => `${u.name}: ${money2(u.price)} (${u.attributedToName})`).join("; ");
    return [
      s.date || "", s.car || "", s.customerName || "", s.customerPhone || "", s.customerEmail || "",
      s.baseService || "", s.employeeNames || "Unassigned", money2(s.basePrice), money2(saleUpsellTotal(s)), money2(saleTotal(s)),
      s.status || "pending", s.completed ? "Yes" : "No", s.paid ? "Yes" : "No", s.paymentMethod || "", upsellDetail,
    ];
  });
  const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  const filename = `sbn-tracker-export-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

app.get("/api/owner/summary", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = revenueEligible(db.sales.filter((s) => inRange(s.date, start, end)), db);
  // "Total revenue" means money actually collected — decided purely by whether payment
  // (cash, card, or both) has been marked, regardless of whether Service Complete is
  // checked. A job can be paid before the work is finished (deposit, pay-ahead, etc.) and
  // that money is real the moment it's collected.
  const realizedSales = sales.filter((s) => s.paid);
  const totalRevenue = realizedSales.reduce((a, s) => a + saleTotal(s), 0);
  const totalUpsell = realizedSales.reduce((a, s) => a + saleUpsellTotal(s), 0);
  // Walk-in revenue — how much of that realized total came from walk-ins specifically,
  // same paid basis as Total Revenue so the numbers are a genuine breakdown, not a
  // different measurement.
  const walkInRevenue = realizedSales.filter((s) => s.isWalkIn).reduce((a, s) => a + saleTotal(s), 0);
  // "Cars serviced" means the job is actually done — a manager marked it Service Complete.
  // Everything still on the schedule (booked, arrived-but-not-done, etc.) doesn't count yet.
  const completedSales = sales.filter((s) => s.completed);
  const carCount = completedSales.length;
  const attachRate = carCount ? (completedSales.filter((s) => (s.upsells || []).length > 0).length / carCount) * 100 : 0;

  // Booking pipeline breakdown — separate from the strict "Total Revenue" above, this shows
  // what's still upcoming (booked but hasn't happened yet) vs. what's already shown up
  // (regardless of whether it's been fully wrapped up and paid).
  const pendingSales = sales.filter((s) => !s.status || s.status === "pending");
  const bookedNotShownValue = pendingSales.reduce((a, s) => a + saleTotal(s), 0);
  const bookedNotShownCount = pendingSales.length;
  const shownUpSales = sales.filter((s) => s.status === "arrived");
  const shownUpValue = shownUpSales.reduce((a, s) => a + saleTotal(s), 0);
  const shownUpCount = shownUpSales.length;

  // Base price isn't split per tech since jobs are tag-teamed — "cars worked" and each
  // person's own logged upsell revenue are the numbers that stay unambiguous here.
  const perEmployee = db.employees.map((emp) => {
    const carsWorked = sales.filter((s) => saleEmployeeIds(s).includes(emp.id));
    const myUpsellRevenue = sales.reduce((a, s) => a + (s.upsells || []).filter((u) => u.employeeId === emp.id).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
    return { id: emp.id, name: emp.name, cars: carsWorked.length, upsellRevenue: myUpsellRevenue };
  });
  // Managers upsell too — same idea, but they're not "assigned" to cars the way techs are,
  // so there's no cars-worked count for them, just their own upsell revenue.
  const perManager = db.managers.map((mgr) => {
    const myUpsellRevenue = sales.reduce((a, s) => a + (s.upsells || []).filter((u) => u.managerId === mgr.id).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
    return { id: mgr.id, name: mgr.name, upsellRevenue: myUpsellRevenue };
  });
  // Sales reps get commission on the BASE sale, only when it showed (manager-marked) —
  // completely separate from upsell commission the techs/managers earn.
  const perSalesRep = db.salesReps.map((rep) => {
    const mine = sales.filter((s) => s.salesRepId === rep.id);
    const showed = mine.filter((s) => s.status === "arrived");
    const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    const commission = showed.reduce((a, s) => a + salesRepCommissionForSale(rep, s).amount, 0);
    return { id: rep.id, name: rep.name, totalBooked: mine.length, showedCount: showed.length, showedValue, commissionRate: rep.commissionRate || 0, commission };
  });

  const leaderboard = [];
  const grouped = {};
  sales.forEach((s) => resolveUpsellNames(s.upsells, db).forEach((u) => {
    const key = u.name.trim() + "||" + u.attributedToName;
    grouped[key] = grouped[key] || { upsell: u.name.trim(), employee: u.attributedToName, count: 0, revenue: 0 };
    grouped[key].count += 1;
    grouped[key].revenue += parseFloat(u.price) || 0;
  }));
  Object.values(grouped).sort((a, b) => b.revenue - a.revenue).forEach((r) => leaderboard.push(r));

  res.json({
    totalRevenue, totalUpsellRevenue: totalUpsell, walkInRevenue,
    upsellPercentOfRevenue: totalRevenue ? (totalUpsell / totalRevenue) * 100 : 0,
    carCount, attachRate, perEmployee, perManager, perSalesRep, leaderboard,
    bookedNotShownValue, bookedNotShownCount, shownUpValue, shownUpCount,
  });
});

const server = app.listen(PORT, () => {
  console.log(`SBN Autostyling Tracker running on port ${PORT}`);
  // First backup shortly after boot (so you don't wait an hour to confirm it's working),
  // then every hour after that — no manual clicking required.
  setTimeout(runCloudBackup, 15 * 1000);
  setInterval(runCloudBackup, 60 * 60 * 1000);
  // Same idea for title sync — GHL never tells us when a title gets edited, so this asks
  // directly, on its own, every 30 minutes, no manual click required.
  setTimeout(runTitleSync, 30 * 1000);
  setInterval(runTitleSync, 30 * 60 * 1000);
});
// A walk-around video can take a while to upload on a slow shop wifi or mobile connection —
// Node's default request timeout is too tight for that, so this gives uploads real room.
server.requestTimeout = 10 * 60 * 1000; // 10 minutes
server.headersTimeout = 10 * 60 * 1000 + 1000;
