' SBN Leaderboard: the whole screen. The tracker decides everything (the ranking, which deals are new, which sound plays);
' this app only draws it and plays the sounds. It asks the tracker for a fresh feed every 15 seconds.

sub init()
    m.cfg = loadConfig()
    m.rowsGroup = m.top.findNode("rows")
    m.statusLabel = m.top.findNode("status")
    m.emptyLabel = m.top.findNode("empty")
    m.clockLabel = m.top.findNode("clock")
    m.banner = m.top.findNode("banner")
    m.feedTask = m.top.findNode("feedTask")
    m.dlTask = m.top.findNode("dlTask")
    m.pollTimer = m.top.findNode("pollTimer")
    m.clockTimer = m.top.findNode("clockTimer")
    m.bannerTimer = m.top.findNode("bannerTimer")
    m.state = tv_newState()
    m.have = {}
    m.wanted = []
    m.downloading = false
    m.dlId = ""
    m.queue = []
    m.bannerBusy = false
    m.polling = false
    m.clockBase = invalid
    m.clockAt = 0
    m.volume = 70
    m.player = invalid
    m.feedTask.observeField("result", "onFeed")
    m.dlTask.observeField("result", "onDownloaded")
    m.pollTimer.observeField("fire", "pollNow")
    m.clockTimer.observeField("fire", "tickClock")
    m.bannerTimer.observeField("fire", "bannerDone")
    if m.cfg = invalid or m.cfg.server = invalid or m.cfg.key = invalid
        m.statusLabel.text = "This app is not set up. Download it again from the tracker's Settings."
        print "TV> no config"
        return
    end if
    print "TV> start server=" + m.cfg.server
    if m.cfg.pollSeconds <> invalid then m.pollTimer.duration = m.cfg.pollSeconds       ' optional: tests refresh faster than the normal 15 seconds
    if m.cfg.bannerSeconds <> invalid then m.bannerTimer.duration = m.cfg.bannerSeconds ' optional: tests don't wait the normal 9 seconds
    m.pollTimer.control = "start"
    m.clockTimer.control = "start"
    pollNow()
end sub

function loadConfig() as dynamic
    text = ReadAsciiFile("pkg:/config.json")
    if text = invalid or text = "" then return invalid
    return ParseJson(text)
end function

sub pollNow()
    if m.cfg = invalid then return
    if m.polling then return
    m.polling = true
    m.feedTask.url = m.cfg.server + "/api/tv/feed"
    m.feedTask.key = m.cfg.key
    m.feedTask.control = "RUN"
end sub

sub onFeed()
    m.polling = false
    r = m.feedTask.result
    if r = invalid then return
    if r.ok
        m.statusLabel.text = ""
        applyFeed(r.data)
    else if r.code = 401 or r.code = 403
        m.statusLabel.text = "This app's key was turned off. Download a new Roku app from the tracker's Settings."
        print "TV> key refused"
    else
        m.statusLabel.text = "Can't reach the tracker right now. Trying again..."
        print "TV> feed failed code=" + r.code.ToStr()
    end if
end sub

sub applyFeed(feed as object)
    if feed.clock <> invalid
        m.clockBase = feed.clock.h * 3600 + feed.clock.m * 60 + feed.clock.s
        m.clockAt = Uptime(0)
        tickClock()
    end if
    m.volume = tv_volume(feed.volume)
    if feed.unreachable <> invalid and feed.unreachable.Count() > 0
        names = ""
        for each n in feed.unreachable
            if names <> "" then names = names + ", "
            names = names + n
        end for
        m.statusLabel.text = "Not reachable right now: " + names
        print "TV> status " + m.statusLabel.text
    end if
    rows = feed.rows
    if rows = invalid then rows = []
    renderRows(rows)
    closes = feed.closes
    if closes = invalid then closes = []
    print "TV> feed ok rows=" + rows.Count().ToStr() + " closes=" + closes.Count().ToStr()
    fresh = tv_newBanners(m.state, closes)
    for each c in fresh
        m.queue.Push(c)
    end for
    showNextBanner()
    if feed.customSounds <> invalid
        for each id in feed.customSounds
            if not m.have.DoesExist(id) and not tv_inList(m.wanted, id) and id <> m.dlId
                m.wanted.Push(id)
            end if
        end for
        startDownloads()
    end if
end sub

function tv_inList(list as object, item as string) as boolean
    for each x in list
        if x = item then return true
    end for
    return false
end function

sub tickClock()
    if m.clockBase = invalid then return
    elapsed = Int(Uptime(0) - m.clockAt)
    m.clockLabel.text = tv_clockText(m.clockBase, elapsed)
end sub

sub renderRows(rows as object)
    while m.rowsGroup.getChildCount() > 0
        m.rowsGroup.removeChildIndex(0)
    end while
    if rows.Count() = 0
        m.emptyLabel.text = "No activity yet today."
        m.emptyLabel.visible = true
        return
    end if
    m.emptyLabel.visible = false
    shown = tv_visibleCount(rows.Count())
    y = 210
    for i = 0 to shown - 1
        addRow(i, rows[i], y)
        y = y + 112
    end for
    if rows.Count() > shown
        more = makeLabel(180, y + 4, 1560, 36, "+ " + (rows.Count() - shown).ToStr() + " more", "font:SmallSystemFont", "0x7F8CA6FF")
        more.horizAlign = "center"
        m.rowsGroup.appendChild(more)
    end if
end sub

sub addRow(i as integer, r as object, y as integer)
    card = CreateObject("roSGNode", "Rectangle")
    card.translation = [180, y]
    card.width = 1560
    card.height = 100
    if i = 0
        card.color = "0x1C2A44FF"
    else
        card.color = "0x151E30FF"
    end if
    m.rowsGroup.appendChild(card)

    badge = CreateObject("roSGNode", "Rectangle")
    badge.translation = [210, y + 18]
    badge.width = 64
    badge.height = 64
    badge.color = rankColor(i)
    m.rowsGroup.appendChild(badge)
    rank = makeLabel(210, y + 18, 64, 64, (i + 1).ToStr(), "font:LargeBoldSystemFont", "0x0A1020FF")
    rank.horizAlign = "center"
    rank.vertAlign = "center"
    m.rowsGroup.appendChild(rank)

    m.rowsGroup.appendChild(makeLabel(310, y + 20, 640, 60, r.name, "font:LargeBoldSystemFont", "0xE8EDF5FF"))

    m.rowsGroup.appendChild(makeLabel(990, y + 8, 320, 28, "CLOSING TODAY", "font:SmallestSystemFont", "0x7F8CA6FF"))
    m.rowsGroup.appendChild(makeLabel(990, y + 32, 330, 40, tv_money(r.closedCents), "font:MediumBoldSystemFont", "0x7FB0FFFF"))
    deals = "deals"
    if r.closeCount = 1 then deals = "deal"
    m.rowsGroup.appendChild(makeLabel(990, y + 70, 320, 26, r.closeCount.ToStr() + " " + deals, "font:SmallestSystemFont", "0xB4C0D8FF"))

    m.rowsGroup.appendChild(makeLabel(1370, y + 8, 340, 28, "ARRIVED TODAY", "font:SmallestSystemFont", "0x7F8CA6FF"))
    m.rowsGroup.appendChild(makeLabel(1370, y + 32, 340, 40, r.arrivedCount.ToStr(), "font:MediumBoldSystemFont", "0xE8EDF5FF"))
    m.rowsGroup.appendChild(makeLabel(1370, y + 70, 340, 26, tv_money(r.commissionCents), "font:SmallestSystemFont", "0x5BD68AFF"))
end sub

function rankColor(i as integer) as string
    if i = 0 then return "0xE0B13AFF"
    if i = 1 then return "0xB8C0CCFF"
    if i = 2 then return "0xC47F4AFF"
    return "0x3A4A6BFF"
end function

function makeLabel(x as integer, y as integer, w as integer, h as integer, text as string, font as string, color as string) as object
    lbl = CreateObject("roSGNode", "Label")
    lbl.translation = [x, y]
    lbl.width = w
    lbl.height = h
    lbl.text = text
    lbl.font = font
    lbl.color = color
    return lbl
end function

' ---- the "Deal closed" banner, one at a time, with the deal's own sound ----
sub showNextBanner()
    if m.bannerBusy then return
    if m.queue.Count() = 0 then return
    m.bannerBusy = true
    c = m.queue.Shift()
    more = m.queue.Count()
    m.top.findNode("bannerMain").text = c.repName + " just closed " + tv_money(c.priceCents)
    detail = c.service
    if detail = invalid then detail = ""
    if c.location <> invalid and c.location <> ""
        if detail <> "" then detail = detail + "  -  " + c.location else detail = c.location
    end if
    if more > 0 then detail = detail + "   (+" + more.ToStr() + " more)"
    m.top.findNode("bannerSub").text = detail
    m.banner.visible = true
    print "TV> banner " + c.repName + " " + tv_money(c.priceCents)
    playSound(c.sound)
    m.bannerTimer.control = "start"
end sub

sub bannerDone()
    m.banner.visible = false
    m.bannerBusy = false
    showNextBanner()
end sub

sub playSound(sound as dynamic)
    path = tv_soundPath(sound, m.have)
    if path = ""
        print "TV> silent"
        return
    end if
    res = CreateObject("roAudioResource", path)
    if res <> invalid
        m.player = res
        res.Trigger(m.volume)
        print "TV> play " + path + " volume=" + m.volume.ToStr()
    else
        print "TV> could not open " + path
    end if
end sub

' ---- the owner's own sounds: fetched one at a time and kept until the app closes ----
sub startDownloads()
    if m.downloading then return
    if m.wanted.Count() = 0 then return
    m.dlId = m.wanted.Shift()
    m.downloading = true
    m.dlTask.url = m.cfg.server + "/api/tv/sound/" + m.dlId
    m.dlTask.key = m.cfg.key
    m.dlTask.path = "tmp:/tv_" + m.dlId + ".wav"
    m.dlTask.control = "RUN"
end sub

sub onDownloaded()
    r = m.dlTask.result
    m.downloading = false
    if r <> invalid and r.ok
        m.have[m.dlId] = true
        print "TV> sound ready " + m.dlId
    else
        print "TV> sound download failed " + m.dlId
    end if
    m.dlId = ""
    startDownloads()
end sub
