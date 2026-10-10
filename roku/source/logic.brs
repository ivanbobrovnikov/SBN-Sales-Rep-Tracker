' SBN Leaderboard: the small pure helpers. They take plain values and give back plain values (no screen, no network),
' so they can be tested away from a TV.

' Money arrives from the tracker as WHOLE CENTS (9428699 means $94,286.99). The TV's numbers are single-precision, which loses cents on
' larger amounts if decimals are used, so money is only ever handled as a whole number of cents.
function tv_money(cents as dynamic) as string
    if cents = invalid then cents = 0
    c = Int(cents)
    sign = ""
    if c < 0
        sign = "-"
        c = -c
    end if
    dollars = c \ 100
    rest = c - dollars * 100
    ds = dollars.ToStr()
    out = ""
    while Len(ds) > 3
        out = "," + Right(ds, 3) + out
        ds = Left(ds, Len(ds) - 3)
    end while
    out = ds + out
    r = rest.ToStr()
    if Len(r) < 2 then r = "0" + r
    return sign + "$" + out + "." + r
end function

function tv_newState() as object
    return { seen: {}, baseline: false }
end function

' Which closes deserve a "Deal closed" banner right now. Same rules as the web leaderboard:
'  - the first look at the board is only the starting point: nothing on it is announced
'  - after that a close is announced once, and only if it is fresh (20 minutes or less old) and already has a price
'  - an old or undated close is quietly noted; a fresh one with no price yet waits until it has one
function tv_newBanners(state as object, closes as dynamic) as object
    out = []
    if closes = invalid then return out
    if not state.baseline
        for each c in closes
            state.seen[c.key] = true
        end for
        state.baseline = true
        return out
    end if
    for each c in closes
        if not state.seen.DoesExist(c.key)
            age = c.ageSec
            if age = invalid or age > 1200
                state.seen[c.key] = true
            else if c.priceCents <> invalid and c.priceCents > 0
                state.seen[c.key] = true
                out.Push(c)
            end if
        end if
    end for
    return out
end function

' seconds since midnight (Eastern) -> "5:44:06 PM"
function tv_clockText(baseSecs as integer, elapsed as integer) as string
    t = (baseSecs + elapsed) mod 86400
    h24 = t \ 3600
    m = (t - h24 * 3600) \ 60
    s = t - h24 * 3600 - m * 60
    ampm = "AM"
    if h24 >= 12 then ampm = "PM"
    h = h24 mod 12
    if h = 0 then h = 12
    ms = m.ToStr()
    if Len(ms) < 2 then ms = "0" + ms
    ss = s.ToStr()
    if Len(ss) < 2 then ss = "0" + ss
    return h.ToStr() + ":" + ms + ":" + ss + " " + ampm
end function

' where to find the sound the tracker chose for a deal ("" = stay quiet)
function tv_soundPath(sound as dynamic, have as object) as string
    if sound = invalid then return ""
    if sound.kind = "builtin" then return "pkg:/sounds/" + sound.key + ".wav"
    if sound.kind = "custom"
        if have.DoesExist(sound.id) then return "tmp:/tv_" + sound.id + ".wav"
        if sound.fallback <> invalid then return "pkg:/sounds/" + sound.fallback + ".wav"
    end if
    return ""
end function

' the TV shows the top six reps (the text is big, so that is what fits); 0 means "none"
function tv_visibleCount(total as integer) as integer
    if total > 6 then return 6
    return total
end function

' 0..100 volume for the audio player, from the tracker's setting
function tv_volume(v as dynamic) as integer
    if v = invalid then return 70
    n = Int(v)
    if n < 1 then n = 1
    if n > 100 then n = 100
    return n
end function

' The ways the TV may play a sound, in the order to try them. Some TVs are silent with one way and fine with the other, so by default it tries
' the audio player first and the sound-effects player after it; the owner can force one in the tracker's Settings.
function tv_attempts(method as dynamic) as object
    if method = "effects" then return [{ method: "effects", fmt: "" }]
    if method = "player" then return [{ method: "player", fmt: "" }, { method: "player", fmt: "wav" }]
    return [{ method: "player", fmt: "" }, { method: "player", fmt: "wav" }, { method: "effects", fmt: "" }]
end function

' any value as text ("" if it can't be)
function tv_text(v as dynamic) as string
    if v = invalid then return ""
    if GetInterface(v, "ifToStr") <> invalid then return v.ToStr()
    return ""
end function

' ---- who moved up or down since the last refresh: the arrow stays next to their rank for two minutes ----
function tv_newRankState() as object
    return { ranks: {}, changes: {} }
end function

' Remembers each rep's rank; a rep whose rank differs from last time gets an arrow until `now + 120` seconds. Returns the names that moved.
function tv_updateRanks(state as object, rows as object, now as dynamic) as object
    moved = []
    for each r in rows
        name = r.name
        if state.ranks.DoesExist(name)
            old = state.ranks[name]
            if r.rank < old
                state.changes[name] = { dir: "up", until: now + 120 }
                moved.Push(name)
            else if r.rank > old
                state.changes[name] = { dir: "down", until: now + 120 }
                moved.Push(name)
            end if
        end if
        state.ranks[name] = r.rank
    end for
    expired = []
    for each key in state.changes
        if state.changes[key].until < now then expired.Push(key)
    end for
    for each key in expired
        state.changes.Delete(key)
    end for
    return moved
end function

function tv_arrowFor(state as object, name as string, now as dynamic) as string
    if state.changes.DoesExist(name)
        if state.changes[name].until >= now then return state.changes[name].dir
    end if
    return ""
end function

' A count-up: the amount (in cents) shown when `t` (0 to 1) of the way from `a` to `b`, slowing down as it arrives.
function tv_countValue(a as integer, b as integer, t as dynamic) as integer
    if t >= 1 then return b
    if t <= 0 then return a
    ' (CDbl only takes whole numbers and would chop 0.5 down to 0, so a decimal becomes a double by multiplying it by a double instead)
    td = t * 1#
    u = 1# - td
    p = 1# - u * u * u
    delta = (b - a) * 1#
    return a + Int(delta * p + 0.5#)
end function

' ---- goal progress bars ----
function tv_goalPct(goal as dynamic) as integer
    if goal = invalid then return -1
    p = goal.pct
    if p = invalid then return -1
    if p < 0 then p = 0
    if p > 100 then p = 100
    return Int(p)
end function

function tv_goalColor(pct as integer) as string
    if pct >= 100 then return "0x22C55EFF"
    if pct >= 40 then return "0x4F8BFFFF"
    return "0xF59E0BFF"
end function

function tv_barWidth(pct as integer, full as integer) as integer
    if pct <= 0 then return 0
    if pct >= 100 then return full
    w = (full * pct) \ 100
    if w < 6 then w = 6
    return w
end function

function tv_pctText(goal as dynamic) as string
    p = tv_goalPct(goal)
    if p < 0 then return ""
    if p >= 100 then return "GOAL HIT"
    return p.ToStr() + "%"
end function

function tv_goalText(goal as dynamic) as string
    if goal = invalid then return ""
    label = "WEEKLY GOAL"
    if goal.cadence = "month" then label = "MONTHLY GOAL"
    if goal.metric = "closes" then return label + "   " + tv_text(goal.current) + " of " + tv_text(goal.target) + " deals"
    kind = ""
    if goal.metric = "commission" then kind = " commission"
    return label + kind + "   " + tv_money(goal.current) + " of " + tv_money(goal.target)
end function
