' SBN Leaderboard: the layouts. Each one is a pure function that takes the feed and the display settings and returns a LIST OF THINGS TO DRAW
' (boxes, text, pictures with exact positions). Nothing here touches the screen, so every layout can be run and drawn away from a TV.
' The scene turns each item into a real node. Item kinds: { t:"r" box }, { t:"l" text }, { t:"p" picture }.

function L_r(x as integer, y as integer, w as integer, h as integer, c as string) as object
    return { t: "r", x: x, y: y, w: w, h: h, c: c }
end function

' text: wt is "bold" or "semibold", al is "left" / "center" / "right", va is "top" / "center".
' The text is fitted to its box here, once, for every layout: it is shrunk (never below 62% of the size asked for) until it fits the box, and only then trimmed with "...".
' The 0.53 is the average width of a character as a share of the font size, measured from the real Oswald fonts (digits and "$" are narrower, 0.50).
function L_t(x as integer, y as integer, w as integer, h as integer, s as string, c as string, wt as string, sz as integer, al as string, va as string) as object
    size = sz
    hmax = Int(h / 1.2)
    if size > hmax then size = hmax
    f = 0.53
    if Left(s, 1) = "$" then f = 0.5
    minSz = Int(sz * 0.62)
    while size > minSz and Len(s) * f * size > w
        size = size - 1
    end while
    if Len(s) * f * size > w
        keep = Int(w / (f * size)) - 3
        if keep < 1 then keep = 1
        s = Left(s, keep) + "..."
    end if
    return { t: "l", x: x, y: y, w: w, h: h, s: s, c: c, wt: wt, sz: size, al: al, va: va }
end function

function L_i(x as integer, y as integer, w as integer, h as integer, u as string, b as string) as object
    return { t: "p", x: x, y: y, w: w, h: h, u: u, b: b }
end function

' bigger text for the "large" text size setting
function L_z(n as integer, d as object) as integer
    if d <> invalid and d.textSize = "large" then return Int(n * 1.14 + 0.5)
    return n
end function

function tv_rankColor(i as integer) as string
    if i = 0 then return "0xE0B13AFF"
    if i = 1 then return "0xB8C0CCFF"
    if i = 2 then return "0xC47F4AFF"
    return "0x4A5B80FF"
end function

' whole dollars for the big numbers ($22,730), cents everywhere else
function tv_moneyShort(cents as dynamic) as string
    s = tv_money(cents)
    return Left(s, Len(s) - 3)
end function

function L_plural(n as dynamic, one as string, many as string) as string
    if n = invalid then n = 0
    if n = 1 then return "1 " + one
    return n.ToStr() + " " + many
end function

function L_age(sec as dynamic) as string
    if sec = invalid then return ""
    if sec < 90 then return "just now"
    if sec < 3600 then return Int(sec / 60).ToStr() + " min ago"
    if sec < 86400 then return Int(sec / 3600).ToStr() + " hr ago"
    return "earlier"
end function

function L_color(r as dynamic) as string
    if r <> invalid and r.color <> invalid then return r.color
    return "0x3B82F6FF"
end function

function L_initials(r as object) as string
    if r.initials <> invalid then return r.initials
    return ""
end function

' the title, subtitle and the clock's place: every layout starts with this
function L_head(title as string, subtitle as string, d as object) as object
    items = []
    items.Push(L_t(480, 30, 900, 84, title, "0xF2F5FBFF", "bold", 62, "left", "top"))
    items.Push(L_t(484, 116, 900, 40, subtitle, "0x8393B2FF", "semibold", 28, "left", "top"))
    return items
end function

' a rep's avatar centred on (cx, cy): their photo in a ring of their colour when we have it, otherwise a coloured circle with their initials
function L_avatar(items as object, r as object, cx as integer, cy as integer, dia as integer, d as object, have as object) as void
    pid = tv_photoId(r)
    col = L_color(r)
    if d <> invalid and d.photos <> false and pid <> "" and have <> invalid and have.DoesExist(pid)
        items.Push(L_i(cx - Int(dia / 2) - 4, cy - Int(dia / 2) - 4, dia + 8, dia + 8, "pkg:/images/circle.png", col))
        items.Push(L_i(cx - Int(dia / 2), cy - Int(dia / 2), dia, dia, tv_photoPath(pid), ""))
    else
        items.Push(L_i(cx - Int(dia / 2), cy - Int(dia / 2), dia, dia, "pkg:/images/circle.png", col))
        items.Push(L_t(cx - Int(dia / 2), cy - Int(dia / 2), dia, dia, L_initials(r), "0xFFFFFFFF", "semibold", Int(dia * 0.42), "center", "center"))
    end if
end function

function L_empty(title as string, subtitle as string, d as object) as object
    items = L_head(title, subtitle, d)
    items.Push(L_t(100, 480, 1720, 90, "No closes yet today", "0x7F8CA6FF", "semibold", 56, "center", "center"))
    return items
end function

' progress to goal as a percentage that CAN pass 100. The tracker caps its own figure at 100, so when the amounts are there it is worked out from them.
function L_goalRaw(goal as dynamic) as integer
    if goal = invalid then return -1
    if goal.current <> invalid
        if goal.target <> invalid
            if goal.target > 0 then return Int((goal.current * 100#) / goal.target)
        end if
    end if
    return tv_goalPct(goal)
end function

function L_commissionOn(d as object) as boolean
    if d <> invalid and d.commission = false then return false
    return true
end function

' ---------------------------------------------------------------- 2. PODIUM
sub L_podBlock(items as object, r as object, i as integer, cx as integer, base as integer, h as integer, d as object, have as object)
    top = base - h
    fill = "0x16233FFF"
    if i = 0 then fill = "0x1A2A4DFF"
    items.Push(L_r(cx - 150, top, 300, h, fill))
    items.Push(L_r(cx - 150, top, 300, 6, tv_rankColor(i)))
    nsz = Int((h - 12) / 1.25)
    if nsz > 100 then nsz = 100
    items.Push(L_t(cx - 150, top + 12, 300, h - 12, (i + 1).ToStr(), tv_rankColor(i), "bold", nsz, "center", "center"))
    items.Push(L_t(cx - 250, top - 84, 500, 76, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(64, d), "center", "center"))
    items.Push(L_t(cx - 250, top - 138, 500, 54, r.name, "0xF2F5FBFF", "semibold", L_z(44, d), "center", "center"))
    L_avatar(items, r, cx, top - 200, 104, d, have)
end sub

function L_podium(rows as object, totals as object, d as object, have as object) as object
    if rows.Count() = 0 then return L_empty("TODAY'S PODIUM", "Top closers by value closed today", d)
    items = L_head("TODAY'S PODIUM", "Top closers by value closed today", d)
    base = 700
    items.Push(L_r(160, base, 1600, 3, "0x25324FFF"))
    if rows.Count() > 1 then L_podBlock(items, rows[1], 1, 540, base, 140, d, have)
    L_podBlock(items, rows[0], 0, 960, base, 190, d, have)
    if rows.Count() > 2 then L_podBlock(items, rows[2], 2, 1380, base, 100, d, have)
    k = 0
    for i = 3 to rows.Count() - 1
        if k >= 4 then exit for
        r = rows[i]
        x = 100 + k * 436
        items.Push(L_r(x, 752, 410, 250, "0x111A30FF"))
        items.Push(L_r(x, 752, 410, 6, L_color(r)))
        items.Push(L_t(x + 20, 772, 60, 40, "#" + (i + 1).ToStr(), "0x8393B2FF", "semibold", 30, "left", "center"))
        L_avatar(items, r, x + 62, 862, 64, d, have)
        items.Push(L_t(x + 110, 832, 290, 56, r.name, "0xF2F5FBFF", "semibold", L_z(36, d), "left", "center"))
        items.Push(L_t(x + 20, 902, 380, 70, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(58, d), "left", "center"))
        items.Push(L_t(x + 20, 962, 380, 34, L_plural(r.closeCount, "deal", "deals") + "  -  " + L_plural(r.arrivedCount, "arrived", "arrived"), "0x8393B2FF", "semibold", 24, "left", "center"))
        k = k + 1
    end for
    return items
end function

' ---------------------------------------------------------------- 3. RACE TO THE GOAL
function L_race(rows as object, totals as object, d as object, have as object) as object
    hasGoal = false
    noGoal = false
    for each r in rows
        if tv_goalPct(r.goal) >= 0 then hasGoal = true else noGoal = true
    end for
    title = "THE RACE"
    sub0 = "Bars show each rep's value closed today, against the leader"
    if hasGoal
        title = "THE RACE TO THE GOAL"
        sub0 = "Everyone's progress to their goal"
        if noGoal then sub0 = "Progress to goal. A rep with no goal set races against the leader"
    end if
    if rows.Count() = 0 then return L_empty(title, sub0, d)
    items = L_head(title, sub0, d)
    best = 1
    for each r in rows
        if r.closedCents > best then best = r.closedCents
    end for
    n = rows.Count()
    if n > 8 then n = 8
    rowH = 96
    trackX = 560
    trackW = 900
    y0 = 222
    items.Push(L_r(trackX + trackW, y0 - 8, 4, n * rowH + 4, "0x6F7C96FF"))
    for i = 0 to n - 1
        r = rows[i]
        y = y0 + i * rowH
        pct = tv_goalPct(r.goal)
        if pct < 0
            if r.closedCents <= 0 then pct = 0 else pct = Int((r.closedCents * 100#) / best)
        end if
        w = tv_barWidth(pct, trackW)
        items.Push(L_i(100, y + 14, 54, 54, "pkg:/images/circle.png", tv_rankColor(i)))
        items.Push(L_t(100, y + 14, 54, 54, (i + 1).ToStr(), "0xFFFFFFFF", "semibold", 28, "center", "center"))
        items.Push(L_t(176, y + 8, 370, 66, r.name, "0xF2F5FBFF", "semibold", L_z(40, d), "left", "center"))
        items.Push(L_r(trackX, y + 20, trackW, 42, "0x16233FFF"))
        if w > 0 then items.Push(L_r(trackX, y + 20, w, 42, L_color(r)))
        carX = trackX + w - 84
        if carX < trackX + 6 then carX = trackX + 6
        items.Push(L_i(carX, y + 6, 90, 70, "pkg:/images/car.png", ""))
        items.Push(L_t(1490, y + 4, 330, 48, tv_moneyShort(r.closedCents), "0xF2F5FBFF", "bold", L_z(40, d), "right", "center"))
        cap = L_plural(r.closeCount, "deal", "deals")
        if tv_pctText(r.goal) <> "" then cap = tv_pctText(r.goal)
        capCol = "0x8393B2FF"
        if pct >= 100 and tv_goalPct(r.goal) >= 0 then capCol = "0x3DDC97FF"
        items.Push(L_t(1490, y + 48, 330, 30, cap, capCol, "semibold", 24, "right", "center"))
    end for
    return items
end function

' ---------------------------------------------------------------- 4. SCOREBOARD
function L_scoreboard(rows as object, totals as object, d as object, have as object) as object
    items = L_head("SCOREBOARD", "Live  -  all locations", d)
    items.Push(L_t(100, 222, 800, 40, "CLOSED TODAY", "0x8393B2FF", "semibold", 32, "left", "center"))
    items.Push(L_t(90, 262, 1180, 300, tv_moneyShort(totals.closedCents), "0xF2F5FBFF", "bold", 250, "left", "center"))
    items.Push(L_r(1360, 258, 460, 150, "0x111A30FF"))
    items.Push(L_t(1388, 270, 400, 36, "DEALS CLOSED", "0x8393B2FF", "semibold", 26, "left", "center"))
    items.Push(L_t(1388, 300, 400, 104, totals.closeCount.ToStr(), "0x7FA8FFFF", "bold", 84, "left", "center"))
    if L_commissionOn(d)
        items.Push(L_r(1360, 424, 460, 150, "0x111A30FF"))
        items.Push(L_t(1388, 436, 400, 36, "COMMISSION EARNED", "0x8393B2FF", "semibold", 26, "left", "center"))
        items.Push(L_t(1388, 472, 420, 96, tv_money(totals.commissionCents), "0x3DDC97FF", "bold", 76, "left", "center"))
    else
        items.Push(L_r(1360, 424, 460, 150, "0x111A30FF"))
        items.Push(L_t(1388, 436, 400, 36, "ARRIVED", "0x8393B2FF", "semibold", 26, "left", "center"))
        items.Push(L_t(1388, 466, 420, 104, totals.arrivedCount.ToStr(), "0x3DDC97FF", "bold", 84, "left", "center"))
    end if
    n = rows.Count()
    if n > 5 then n = 5
    for i = 0 to n - 1
        r = rows[i]
        x = 100 + i * 348
        items.Push(L_r(x, 650, 328, 350, "0x111A30FF"))
        items.Push(L_r(x, 650, 328, 6, L_color(r)))
        items.Push(L_i(x + 18, 680, 48, 48, "pkg:/images/circle.png", tv_rankColor(i)))
        items.Push(L_t(x + 18, 680, 48, 48, (i + 1).ToStr(), "0xFFFFFFFF", "semibold", 26, "center", "center"))
        items.Push(L_t(x + 80, 676, 236, 56, r.name, "0xF2F5FBFF", "semibold", L_nameSize(r.name, L_z(34, d)), "left", "center"))
        items.Push(L_t(x + 18, 760, 296, 90, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(66, d), "left", "center"))
        items.Push(L_t(x + 18, 860, 296, 36, L_plural(r.closeCount, "deal", "deals"), "0x8393B2FF", "semibold", 28, "left", "center"))
        items.Push(L_t(x + 18, 896, 296, 36, L_plural(r.arrivedCount, "arrived", "arrived"), "0x8393B2FF", "semibold", 28, "left", "center"))
    end for
    if n = 0 then items.Push(L_t(100, 760, 1720, 80, "No closes yet today", "0x7F8CA6FF", "semibold", 52, "center", "center"))
    return items
end function

' ---------------------------------------------------------------- THIS MONTH: the total value closed so far this month, all locations, and who closed it
function L_month(month as dynamic, d as object, have as object) as object
    if month = invalid
        items = L_head("THIS MONTH", "All locations", d)
        items.Push(L_t(100, 480, 1720, 90, "Getting this month's total...", "0x7F8CA6FF", "semibold", 56, "center", "center"))
        return items
    end if
    items = L_head("THIS MONTH", month.label + "  -  all locations", d)
    items.Push(L_t(100, 222, 800, 40, "CLOSED THIS MONTH", "0x8393B2FF", "semibold", 32, "left", "center"))
    items.Push(L_t(90, 262, 1180, 300, tv_moneyShort(month.closedCents), "0xF2F5FBFF", "bold", 250, "left", "center"))
    items.Push(L_r(1360, 258, 460, 150, "0x111A30FF"))
    items.Push(L_t(1388, 270, 400, 36, "DEALS CLOSED", "0x8393B2FF", "semibold", 26, "left", "center"))
    items.Push(L_t(1388, 300, 400, 104, month.closeCount.ToStr(), "0x7FA8FFFF", "bold", 84, "left", "center"))
    items.Push(L_r(1360, 424, 460, 150, "0x111A30FF"))
    items.Push(L_t(1388, 436, 400, 36, "AVERAGE DEAL", "0x8393B2FF", "semibold", 26, "left", "center"))
    avg = "-"
    if month.closeCount > 0 then avg = tv_moneyShort(month.closedCents \ month.closeCount)
    items.Push(L_t(1388, 466, 420, 104, avg, "0x3DDC97FF", "bold", 84, "left", "center"))
    rows = month.rows
    if rows = invalid then rows = []
    n = rows.Count()
    if n > 5 then n = 5
    for i = 0 to n - 1
        r = rows[i]
        x = 100 + i * 348
        items.Push(L_r(x, 650, 328, 350, "0x111A30FF"))
        items.Push(L_r(x, 650, 328, 6, L_color(r)))
        items.Push(L_i(x + 18, 680, 48, 48, "pkg:/images/circle.png", tv_rankColor(i)))
        items.Push(L_t(x + 18, 680, 48, 48, (i + 1).ToStr(), "0xFFFFFFFF", "semibold", 26, "center", "center"))
        items.Push(L_t(x + 80, 676, 236, 56, r.name, "0xF2F5FBFF", "semibold", L_nameSize(r.name, L_z(34, d)), "left", "center"))
        items.Push(L_t(x + 18, 760, 296, 90, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(66, d), "left", "center"))
        items.Push(L_t(x + 18, 860, 296, 36, L_plural(r.closeCount, "deal", "deals"), "0x8393B2FF", "semibold", 28, "left", "center"))
        if month.closedCents > 0 then items.Push(L_t(x + 18, 896, 296, 36, Int((r.closedCents * 100#) / month.closedCents).ToStr() + "% of the month", "0x8393B2FF", "semibold", 28, "left", "center"))
    end for
    if n = 0 then items.Push(L_t(100, 760, 1720, 80, "No closes yet this month", "0x7F8CA6FF", "semibold", 52, "center", "center"))
    miss = month.unreachable
    if miss <> invalid and miss.Count() > 0
        names = ""
        for each shopName in miss
            if names <> "" then names = names + ", "
            names = names + shopName
        end for
        items.Push(L_t(100, 1022, 1720, 36, "Not counted (no answer): " + names, "0xF5A524FF", "semibold", 26, "left", "center"))
    end if
    return items
end function

' a font size that keeps a long name inside its box
function L_nameSize(name as string, base as integer) as integer
    n = Len(name)
    if n <= 12 then return base
    if n <= 17 then return Int(base * 0.84)
    return Int(base * 0.7)
end function

' ---------------------------------------------------------------- 5. SPOTLIGHT
function L_spotlight(rows as object, totals as object, d as object, have as object) as object
    if rows.Count() = 0 then return L_empty("TODAY'S LEADER", "Value closed today", d)
    items = L_head("TODAY'S LEADER", "Value closed today", d)
    r = rows[0]
    items.Push(L_r(100, 214, 640, 800, "0x111A30FF"))
    items.Push(L_r(100, 214, 640, 8, tv_rankColor(0)))
    items.Push(L_t(130, 244, 580, 44, "#1 TODAY", tv_rankColor(0), "semibold", 36, "left", "center"))
    L_avatar(items, r, 250, 410, 190, d, have)
    items.Push(L_t(370, 330, 350, 160, r.name, "0xF2F5FBFF", "bold", L_nameSize(r.name, L_z(60, d)), "left", "center"))
    items.Push(L_t(130, 540, 590, 190, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(124, d), "left", "center"))
    items.Push(L_t(130, 790, 190, 34, "DEALS", "0x8393B2FF", "semibold", 26, "left", "center"))
    items.Push(L_t(130, 826, 190, 80, r.closeCount.ToStr(), "0xF2F5FBFF", "bold", 64, "left", "center"))
    items.Push(L_t(330, 790, 190, 34, "ARRIVED", "0x8393B2FF", "semibold", 26, "left", "center"))
    items.Push(L_t(330, 826, 190, 80, r.arrivedCount.ToStr(), "0xF2F5FBFF", "bold", 64, "left", "center"))
    if L_commissionOn(d)
        items.Push(L_t(530, 790, 190, 34, "COMMISSION", "0x8393B2FF", "semibold", 26, "left", "center"))
        items.Push(L_t(530, 826, 190, 80, tv_moneyShort(r.commissionCents), "0x3DDC97FF", "bold", 56, "left", "center"))
    end if
    n = rows.Count() - 1
    if n > 5 then n = 5
    for k = 1 to n
        q = rows[k]
        y = 214 + (k - 1) * 162
        items.Push(L_r(780, y, 1040, 150, "0x111A30FF"))
        items.Push(L_r(780, y, 8, 150, L_color(q)))
        items.Push(L_t(810, y + 10, 70, 130, (k + 1).ToStr(), tv_rankColor(k), "bold", 56, "center", "center"))
        L_avatar(items, q, 934, y + 75, 84, d, have)
        items.Push(L_t(1000, y + 18, 500, 64, q.name, "0xF2F5FBFF", "semibold", L_z(40, d), "left", "center"))
        items.Push(L_t(1000, y + 86, 500, 40, L_plural(q.closeCount, "deal", "deals") + "  -  " + L_plural(q.arrivedCount, "arrived", "arrived"), "0x8393B2FF", "semibold", 26, "left", "center"))
        items.Push(L_t(1500, y + 10, 300, 130, tv_moneyShort(q.closedCents), "0x7FA8FFFF", "bold", L_z(58, d), "right", "center"))
    end for
    return items
end function

' ---------------------------------------------------------------- 6. GOAL PROGRESS RINGS
function tv_ringFile(pct as integer) as string
    p = Int((pct + 2) / 5) * 5
    if p < 0 then p = 0
    if p > 100 then p = 100
    s = p.ToStr()
    if p < 10 then s = "0" + s
    return "pkg:/images/ring_" + s + ".png"
end function

function L_rings(rows as object, totals as object, d as object, have as object) as object
    hasGoal = false
    noGoal = false
    for each r in rows
        if tv_goalPct(r.goal) >= 0 then hasGoal = true else noGoal = true
    end for
    sub0 = "Ring shows value closed against the leader"
    if hasGoal then sub0 = "Each ring is progress to that rep's goal"
    if hasGoal and noGoal then sub0 = "Progress to goal. A ring with a number inside has no goal set: it shows deals against the leader"
    if rows.Count() = 0 then return L_empty("GOAL PROGRESS", sub0, d)
    items = L_head("GOAL PROGRESS", sub0, d)
    best = 1
    for each r in rows
        if r.closedCents > best then best = r.closedCents
    end for
    n = rows.Count()
    if n > 6 then n = 6
    for i = 0 to n - 1
        r = rows[i]
        col = i mod 3
        row = i \ 3
        x = 100 + col * 580
        y = 214 + row * 408
        pct = tv_goalPct(r.goal)
        centre = ""
        ringCol = tv_goalColor(pct)
        if pct >= 0
            centre = L_goalRaw(r.goal).ToStr() + "%"
        else
            if r.closedCents <= 0 then pct = 0 else pct = Int((r.closedCents * 100#) / best)
            ringCol = L_color(r)
            centre = r.closeCount.ToStr()
        end if
        items.Push(L_r(x, y, 560, 388, "0x111A30FF"))
        items.Push(L_i(x + 20, y + 16, 46, 46, "pkg:/images/circle.png", tv_rankColor(i)))
        items.Push(L_t(x + 20, y + 16, 46, 46, (i + 1).ToStr(), "0xFFFFFFFF", "semibold", 26, "center", "center"))
        items.Push(L_t(x + 80, y + 12, 460, 54, r.name, "0xF2F5FBFF", "semibold", L_nameSize(r.name, L_z(38, d)), "left", "center"))
        items.Push(L_i(x + 28, y + 100, 250, 250, "pkg:/images/ring_track.png", "0x25324FFF"))
        items.Push(L_i(x + 28, y + 100, 250, 250, tv_ringFile(pct), ringCol))
        items.Push(L_t(x + 28, y + 100, 250, 250, centre, "0xF2F5FBFF", "bold", 58, "center", "center"))
        items.Push(L_t(x + 310, y + 120, 230, 30, "CLOSED", "0x8393B2FF", "semibold", 24, "left", "center"))
        items.Push(L_t(x + 310, y + 150, 240, 70, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(48, d), "left", "center"))
        items.Push(L_t(x + 310, y + 240, 230, 30, "DEALS", "0x8393B2FF", "semibold", 24, "left", "center"))
        items.Push(L_t(x + 310, y + 270, 240, 70, r.closeCount.ToStr(), "0xF2F5FBFF", "bold", 50, "left", "center"))
    end for
    return items
end function

' ---------------------------------------------------------------- 7. LIVE FEED
function L_newestCloses(closes as object, n as integer) as object
    out = []
    used = {}
    for k = 1 to n
        bestI = -1
        bestAge = 99999999
        for i = 0 to closes.Count() - 1
            if not used.DoesExist(i.ToStr())
                a = closes[i].ageSec
                if a = invalid then a = 99999998
                if a < bestAge
                    bestAge = a
                    bestI = i
                end if
            end if
        end for
        if bestI < 0 then exit for
        used[bestI.ToStr()] = true
        out.Push(closes[bestI])
    end for
    return out
end function

function L_feed(rows as object, closes as object, d as object, have as object) as object
    items = L_head("LIVE LEADERBOARD", "Rankings, and the deals as they close", d)
    items.Push(L_r(100, 214, 840, 806, "0x111A30FF"))
    items.Push(L_t(130, 226, 700, 40, "TODAY'S RANKING", "0x8393B2FF", "semibold", 26, "left", "center"))
    n = rows.Count()
    if n > 7 then n = 7
    for i = 0 to n - 1
        r = rows[i]
        y = 274 + i * 104
        items.Push(L_r(130, y + 98, 780, 2, "0x1A2A4DFF"))
        items.Push(L_i(130, y + 22, 52, 52, "pkg:/images/circle.png", tv_rankColor(i)))
        items.Push(L_t(130, y + 22, 52, 52, (i + 1).ToStr(), "0xFFFFFFFF", "semibold", 26, "center", "center"))
        L_avatar(items, r, 236, y + 48, 64, d, have)
        items.Push(L_t(290, y + 8, 400, 80, r.name, "0xF2F5FBFF", "semibold", L_nameSize(r.name, L_z(40, d)), "left", "center"))
        items.Push(L_t(680, y + 8, 230, 80, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(46, d), "right", "center"))
    end for
    if n = 0 then items.Push(L_t(130, 500, 780, 70, "No closes yet today", "0x7F8CA6FF", "semibold", 44, "center", "center"))
    items.Push(L_r(980, 214, 840, 806, "0x111A30FF"))
    items.Push(L_t(1010, 226, 700, 40, "JUST CLOSED", "0x8393B2FF", "semibold", 26, "left", "center"))
    newest = L_newestCloses(closes, 7)
    for i = 0 to newest.Count() - 1
        c = newest[i]
        y = 274 + i * 104
        items.Push(L_r(1010, y + 98, 780, 2, "0x1A2A4DFF"))
        items.Push(L_t(1010, y + 6, 560, 48, c.repName, "0xF2F5FBFF", "semibold", 34, "left", "center"))
        line = c.service
        if c.location <> invalid and c.location <> "" then line = line + "  -  " + c.location
        line = line + "  -  " + L_age(c.ageSec)
        items.Push(L_t(1010, y + 52, 600, 40, line, "0x8393B2FF", "semibold", 24, "left", "center"))
        items.Push(L_t(1590, y + 8, 200, 84, tv_moneyShort(c.priceCents), "0x3DDC97FF", "bold", 42, "right", "center"))
    end for
    if newest.Count() = 0 then items.Push(L_t(1010, 500, 780, 70, "Waiting for the next close", "0x7F8CA6FF", "semibold", 44, "center", "center"))
    return items
end function

' ---------------------------------------------------------------- 8. THE TEAM
function L_cards(rows as object, totals as object, d as object, have as object) as object
    if rows.Count() = 0 then return L_empty("THE TEAM", "Everyone's day at a glance", d)
    items = L_head("THE TEAM", "Everyone's day at a glance", d)
    n = rows.Count()
    if n > 8 then n = 8
    cols = 3
    if n > 6 then cols = 4
    gap = 24
    w = Int((1720 - gap * (cols - 1)) / cols)
    for i = 0 to n - 1
        r = rows[i]
        x = 100 + (i mod cols) * (w + gap)
        y = 214 + (i \ cols) * 424
        items.Push(L_r(x, y, w, 400, "0x111A30FF"))
        items.Push(L_r(x, y, w, 8, L_color(r)))
        L_avatar(items, r, x + 62, y + 86, 76, d, have)
        items.Push(L_t(x + 118, y + 34, w - 136, 52, r.name, "0xF2F5FBFF", "semibold", L_nameSize(r.name, L_z(36, d)), "left", "center"))
        items.Push(L_t(x + 118, y + 86, w - 136, 34, "Rank " + (i + 1).ToStr() + " of " + rows.Count().ToStr(), "0x8393B2FF", "semibold", 24, "left", "center"))
        hw = Int(w / 2)
        items.Push(L_t(x + 24, y + 150, hw - 30, 28, "CLOSED", "0x8393B2FF", "semibold", 22, "left", "center"))
        items.Push(L_t(x + 24, y + 178, hw - 30, 70, tv_moneyShort(r.closedCents), "0x7FA8FFFF", "bold", L_z(48, d), "left", "center"))
        items.Push(L_t(x + hw, y + 150, hw - 24, 28, "DEALS", "0x8393B2FF", "semibold", 22, "left", "center"))
        items.Push(L_t(x + hw, y + 178, hw - 24, 70, r.closeCount.ToStr(), "0xF2F5FBFF", "bold", 48, "left", "center"))
        items.Push(L_t(x + 24, y + 268, hw - 30, 28, "ARRIVED", "0x8393B2FF", "semibold", 22, "left", "center"))
        items.Push(L_t(x + 24, y + 296, hw - 30, 70, r.arrivedCount.ToStr(), "0xF2F5FBFF", "bold", 48, "left", "center"))
        if L_commissionOn(d)
            items.Push(L_t(x + hw, y + 268, hw - 24, 28, "COMMISSION", "0x8393B2FF", "semibold", 22, "left", "center"))
            items.Push(L_t(x + hw, y + 296, hw - 24, 70, tv_moneyShort(r.commissionCents), "0x3DDC97FF", "bold", L_z(44, d), "left", "center"))
        end if
    end for
    return items
end function

' ---------------------------------------------------------------- 9. AMBIENT (dim, calm, top three only; it drifts a few pixels every minute so nothing burns into the screen)
function L_ambient(rows as object, totals as object, d as object, tick as integer) as object
    dx = ((tick mod 9) - 4) * 6
    dy = (((tick \ 2) mod 7) - 3) * 6
    items = []
    items.Push(L_r(0, 0, 1920, 1080, "0x03060DFF"))
    items.Push(L_t(360 + dx, 320 + dy, 1200, 40, "TODAY'S TOP CLOSERS", "0x4A5B80FF", "semibold", 30, "center", "center"))
    n = rows.Count()
    if n > 3 then n = 3
    for i = 0 to n - 1
        r = rows[i]
        y = 410 + i * 150 + dy
        items.Push(L_t(440 + dx, y, 130, 120, (i + 1).ToStr(), tv_rankColor(i), "bold", 96, "center", "center"))
        items.Push(L_t(600 + dx, y, 700, 120, r.name, "0xC9D3E8FF", "semibold", L_nameSize(r.name, L_z(78, d)), "left", "center"))
        items.Push(L_t(1260 + dx, y, 420, 120, tv_moneyShort(r.closedCents), "0x6E93E0FF", "bold", L_z(78, d), "right", "center"))
    end for
    if n = 0 then items.Push(L_t(360 + dx, 480 + dy, 1200, 100, "No closes yet today", "0x4A5B80FF", "semibold", 56, "center", "center"))
    return items
end function

' ---------------------------------------------------------------- the list of layouts, and the one place that picks which to draw
function tv_layoutIds() as object
    return ["classic", "podium", "race", "scoreboard", "month", "spotlight", "rings", "feed", "cards", "ambient"]
end function

function tv_layoutName(id as string) as string
    if id = "classic" then return "Classic board"
    if id = "podium" then return "Podium"
    if id = "race" then return "Race to the goal"
    if id = "scoreboard" then return "Scoreboard"
    if id = "month" then return "This month"
    if id = "spotlight" then return "Spotlight"
    if id = "rings" then return "Goal rings"
    if id = "feed" then return "Live feed"
    if id = "cards" then return "The team"
    if id = "ambient" then return "Ambient"
    return "Classic board"
end function

' returns { items, dim }. "classic" is drawn by the scene itself (it has the count-up and rank arrows), so it returns nothing here.
function tv_stage(layout as string, feed as object, d as object, have as object, tick as integer) as object
    rows = feed.rows
    if rows = invalid then rows = []
    closes = feed.closes
    if closes = invalid then closes = []
    totals = feed.totals
    if totals = invalid then totals = { closedCents: 0, closeCount: 0, arrivedCount: 0, commissionCents: 0 }
    if layout = "podium" then return { items: L_podium(rows, totals, d, have), dim: false }
    if layout = "race" then return { items: L_race(rows, totals, d, have), dim: false }
    if layout = "scoreboard" then return { items: L_scoreboard(rows, totals, d, have), dim: false }
    if layout = "month" then return { items: L_month(feed.month, d, have), dim: false }
    if layout = "spotlight" then return { items: L_spotlight(rows, totals, d, have), dim: false }
    if layout = "rings" then return { items: L_rings(rows, totals, d, have), dim: false }
    if layout = "feed" then return { items: L_feed(rows, closes, d, have), dim: false }
    if layout = "cards" then return { items: L_cards(rows, totals, d, have), dim: false }
    if layout = "ambient" then return { items: L_ambient(rows, totals, d, tick), dim: true }
    return { items: [], dim: false }
end function
