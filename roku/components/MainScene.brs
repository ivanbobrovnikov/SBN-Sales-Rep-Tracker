' SBN Leaderboard: the whole screen. The tracker decides everything (the ranking, which deals are new, which sound plays);
' this app only draws it and plays the sounds. It asks the tracker for a fresh feed every 15 seconds.

sub init()
    m.cfg = loadConfig()
    m.rowsGroup = m.top.findNode("rows")
    m.statusLabel = m.top.findNode("status")
    m.emptyLabel = m.top.findNode("empty")
    m.clockLabel = m.top.findNode("clock")
    m.banner = m.top.findNode("banner")
    m.feedTask = invalid     ' workers are created fresh for every job (see runFeed / startDownloads / sendNextReport)
    m.dlTask = invalid
    m.reportTask = invalid
    m.pollTimer = m.top.findNode("pollTimer")
    m.clockTimer = m.top.findNode("clockTimer")
    m.bannerTimer = m.top.findNode("bannerTimer")
    m.diagLabel = m.top.findNode("diag")
    m.diagTimer = m.top.findNode("diagTimer")
    m.soundTimer = m.top.findNode("soundTimer")
    m.countTimer = m.top.findNode("countTimer")
    m.confettiTimer = m.top.findNode("confettiTimer")
    m.confetti = m.top.findNode("confetti")
    m.confettiAnim = m.top.findNode("confettiAnim")
    m.audio = invalid            ' the audio player is made fresh for every attempt (see stopPlayer / nextAttempt) and never reused
    m.audioMade = 0
    m.soundSeq = 0
    m.lastOutcome = "none"
    m.prevOutcome = "none"
    m.lastSoundAt = 0
    m.state = tv_newState()
    m.have = {}
    m.havePhoto = {}
    m.lastRows = invalid
    m.dlKind = ""
    m.wanted = []
    m.downloading = false
    m.dlId = ""
    m.queue = []
    m.bannerBusy = false
    m.polling = false
    m.pollStarted = 0
    m.dlStarted = 0
    m.reportStarted = 0
    m.clockBase = invalid
    m.clockAt = 0
    m.volume = 70
    m.player = invalid
    m.soundMethod = "auto"
    m.fonts = {}
    m.rankState = tv_newRankState()
    m.prevCents = {}
    m.amountLabels = {}
    m.anims = []
    m.rowsSig = "(nothing drawn yet)"      ' can never equal a real signature, so the very first screen (even an empty one) is always drawn
    m.confettiOn = true
    m.testSeq = invalid
    m.sndPath = ""
    m.sndLabel = ""
    m.sndAttempts = []
    m.sndTry = 0
    m.reportQueue = []
    m.checkTask = invalid
    m.reporting = false
    ' the display settings (layout, rotation, photos, ...): what the TV remembers is used until the tracker answers, and the tracker has the final say
    m.stageGroup = m.top.findNode("stage")
    m.menuGroup = m.top.findNode("menuGroup")
    m.rotateTimer = m.top.findNode("rotateTimer")
    m.sendTimer = m.top.findNode("displaySendTimer")
    m.logoNode = m.top.findNode("logo")
    m.display = tv_cleanDisplay(loadDisplay())
    m.currentLayout = m.display.layout
    m.menuOpen = false
    m.menuSel = 0
    m.tick = 0
    m.secs = 0
    m.lastFeed = invalid
    m.localChangeAt = -100
    m.pending = {}
    m.displayTasks = []
    m.confettiOn = m.display.confetti
    m.volume = tv_menuVolume(m.display.volume)
    m.rotateTimer.observeField("fire", "onRotate")
    m.sendTimer.observeField("fire", "flushDisplay")
    m.top.setFocus(true)
    m.pollTimer.observeField("fire", "pollNow")
    m.clockTimer.observeField("fire", "tickClock")
    m.bannerTimer.observeField("fire", "bannerDone")
    m.diagTimer.observeField("fire", "clearDiag")
    m.soundTimer.observeField("fire", "onSoundTimeout")
    m.countTimer.observeField("fire", "tickCount")
    m.confettiTimer.observeField("fire", "hideConfetti")
    setFont(m.top.findNode("title"), "bold", 66)
    setFont(m.clockLabel, "semibold", 60)
    setFont(m.top.findNode("bannerTop"), "semibold", 30)
    setFont(m.top.findNode("bannerMain"), "bold", 68)
    setFont(m.top.findNode("bannerSub"), "semibold", 34)
    for i = 0 to 2
        setFont(m.top.findNode("tile" + i.ToStr() + "cap"), "semibold", 22)
        setFont(m.top.findNode("tile" + i.ToStr() + "amt"), "bold", 56)
        setFont(m.top.findNode("tile" + i.ToStr() + "sub"), "semibold", 28)
    end for
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
    di = CreateObject("roDeviceInfo")
    osv = di.GetOSVersion()
    osText = ""
    if osv <> invalid then osText = tv_text(osv.major) + "." + tv_text(osv.minor) + " build " + tv_text(osv.build)
    report("started", "SBN Leaderboard 1.2 on " + tv_text(di.GetModelDisplayName()) + " (" + tv_text(di.GetModel()) + ") Roku OS " + osText)
    checkSounds()
    pollNow()
end sub

' One quick check of the sound files inside the installed app, reported to the tracker (is each file the size and content it should be?).
sub checkSounds()
    if m.cfg.skipFileCheck = true then return        ' (tests only: the emulator is very slow at this, a real Roku isn't)
    text = ReadAsciiFile("pkg:/sounds/check.json")
    if text = invalid or text = "" then return
    files = ParseJson(text)
    if files = invalid then return
    task = CreateObject("roSGNode", "CheckTask")
    task.observeField("result", "onChecked")
    task.files = files
    m.checkTask = task
    task.control = "RUN"
end sub

sub onChecked(event as object)
    r = event.getData()
    if r = invalid then return
    for each key in r
        report("file_check", key + ".wav: " + r[key])
        print "TV> file check " + key + " " + r[key]
    end for
end sub

function loadConfig() as dynamic
    text = ReadAsciiFile("pkg:/config.json")
    if text = invalid or text = "" then return invalid
    return ParseJson(text)
end function

' A Roku worker (Task) that has just finished can still count as "running" for a moment, and a request to run it again in that moment is silently
' ignored, so a worker is never reused: every refresh, report and download gets a brand new one. Anything that doesn't come back within 30 seconds
' is given up on and replaced.
sub pollNow()
    if m.cfg = invalid then return
    if m.polling
        if Uptime(0) - m.pollStarted < 30
            print "TV> poll skipped (waiting for the last one)"
            return
        end if
        print "TV> poll took too long, starting a fresh one"
    end if
    m.polling = true
    m.pollStarted = Uptime(0)
    task = CreateObject("roSGNode", "FeedTask")
    task.observeField("result", "onFeed")
    task.url = m.cfg.server + "/api/tv/feed"
    task.key = m.cfg.key
    m.feedTask = task
    task.control = "RUN"
end sub

sub onFeed(event as object)
    task = event.getRoSGNode()
    if m.feedTask = invalid then return
    if not task.isSameNode(m.feedTask) then return      ' a late answer from a refresh we already gave up on
    m.polling = false
    r = event.getData()
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
    m.lastFeed = feed
    if feed.display <> invalid then applyServerDisplay(feed.display)
    if feed.clock <> invalid
        m.clockBase = feed.clock.h * 3600 + feed.clock.m * 60 + feed.clock.s
        m.clockAt = Uptime(0)
        tickClock()
    end if
    m.volume = tv_volume(feed.volume)
    if feed.soundMethod <> invalid then m.soundMethod = feed.soundMethod
    if feed.test <> invalid
        if m.testSeq = invalid
            m.testSeq = feed.test.seq
        else if feed.test.seq <> m.testSeq
            m.testSeq = feed.test.seq
            m.queue.Push({ isTest: true, sound: feed.test.sound })
            print "TV> test sound requested"
        end if
    end if
    if feed.unreachable <> invalid and feed.unreachable.Count() > 0
        names = ""
        for each n in feed.unreachable
            if names <> "" then names = names + ", "
            names = names + n
        end for
        m.statusLabel.text = "Not reachable right now: " + names
        print "TV> status " + m.statusLabel.text
    end if
    if feed.confetti <> invalid then m.confettiOn = feed.confetti
    if feed.totals <> invalid then showTotals(feed.totals)
    rows = feed.rows
    if rows = invalid then rows = []
    m.lastRows = rows
    drawBoard()
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
            queueFile("sound", id)
        end for
    end if
    for each r in rows              ' the reps' photos, top of the board first
        pid = tv_photoId(r)
        if pid <> "" then queueFile("photo", pid)
    end for
    startDownloads()
end sub

' Adds a sound or a photo to the list of files to fetch, unless the TV already has it, is already waiting for it, or is fetching it right now.
sub queueFile(kind as string, id as string)
    if kind = "photo"
        if m.havePhoto.DoesExist(id) then return
    else
        if m.have.DoesExist(id) then return
    end if
    if m.dlKind = kind and m.dlId = id then return
    for each w in m.wanted
        if w.kind = kind and w.id = id then return
    end for
    m.wanted.Push({ kind: kind, id: id })
end sub

function tv_inList(list as object, item as string) as boolean
    for each x in list
        if x = item then return true
    end for
    return false
end function

sub tickClock()
    m.secs = m.secs + 1
    if m.secs mod 60 = 0
        m.tick = m.tick + 1
        if m.currentLayout = "ambient" and m.lastFeed <> invalid and not m.menuOpen then drawStage()      ' the ambient board drifts a few pixels each minute
    end if
    if m.clockBase = invalid then return
    elapsed = Int(Uptime(0) - m.clockAt)
    m.clockLabel.text = tv_clockText(m.clockBase, elapsed)
end sub

' One font per weight and size, made once and shared. Oswald is the typeface the web leaderboard uses.
sub setFont(label as object, weight as string, size as integer)
    key = weight + size.ToStr()
    if not m.fonts.DoesExist(key)
        f = CreateObject("roSGNode", "Font")
        if weight = "bold"
            f.uri = "pkg:/fonts/Oswald-Bold.ttf"
        else
            f.uri = "pkg:/fonts/Oswald-SemiBold.ttf"
        end if
        f.size = size
        m.fonts[key] = f
    end if
    label.font = m.fonts[key]
end sub

sub showTotals(t as object)
    m.top.findNode("tile0amt").text = tv_money(t.closedCents)
    deals = "deals"
    if t.closeCount = 1 then deals = "deal"
    m.top.findNode("tile0sub").text = t.closeCount.ToStr() + " " + deals
    m.top.findNode("tile1amt").text = t.arrivedCount.ToStr()
    cars = "cars"
    if t.arrivedCount = 1 then cars = "car"
    m.top.findNode("tile1sub").text = cars + " on site"
    m.top.findNode("tile2amt").text = tv_money(t.commissionCents)
    m.top.findNode("tile2sub").text = "from arrivals"
end sub

' what the screen would look like for these rows, as one line of text: if it is the same as last time nothing is redrawn (no flicker, no wasted work,
' and a count-up that is in progress isn't interrupted)
function rowsSignature(rows as object, now as dynamic) as string
    sig = ""
    for each r in rows
        p = tv_goalPct(r.goal)
        ph = tv_photoId(r)
        if ph <> ""
            if m.havePhoto.DoesExist(ph) then ph = ph + "+" else ph = ph + "-"
        end if
        sig = sig + ph + "~" + r.name + "|" + tv_text(r.closedCents) + "|" + tv_text(r.arrivedCount) + "|" + tv_text(r.commissionCents) + "|" + tv_text(r.closeCount) + "|" + p.ToStr() + "|" + tv_arrowFor(m.rankState, r.name, now) + ";"
    end for
    return sig
end function

sub renderRows(rows as object)
    now = Uptime(0)
    moved = tv_updateRanks(m.rankState, rows, now)
    for each n in moved
        print "TV> rank change " + n + " " + tv_arrowFor(m.rankState, n, now)
    end for
    sig = rowsSignature(rows, now)
    if sig = m.rowsSig then return
    m.rowsSig = sig
    m.anims = []
    m.amountLabels = {}
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
    y = 328
    for i = 0 to shown - 1
        addRow(i, rows[i], y, tv_arrowFor(m.rankState, rows[i].name, now))
        y = y + 114
    end for
    if rows.Count() > shown
        more = makeLabel(100, y + 2, 1720, 36, "+ " + (rows.Count() - shown).ToStr() + " more", "semibold", 26, "0x7F8CA6FF")
        more.horizAlign = "center"
        m.rowsGroup.appendChild(more)
    end if
    ' a rep whose total went UP since last time counts up to the new amount instead of jumping
    for i = 0 to shown - 1
        r = rows[i]
        if m.prevCents.DoesExist(r.name)
            before = m.prevCents[r.name]
            if r.closedCents > before and m.amountLabels.DoesExist(r.name)
                lbl = m.amountLabels[r.name]
                lbl.text = tv_money(before)
                lbl.color = "0x5BD68AFF"
                m.anims.Push({ label: lbl, from: before, to: r.closedCents, start: now })
                print "TV> count " + r.name + " " + before.ToStr() + " to " + r.closedCents.ToStr()
            end if
        end if
    end for
    for each r in rows
        m.prevCents[r.name] = r.closedCents
    end for
    if m.anims.Count() > 0 then m.countTimer.control = "start"
end sub

sub tickCount()
    now = Uptime(0)
    keep = []
    for each a in m.anims
        t = (now - a.start) / 1.4
        if t >= 1
            a.label.text = tv_money(a.to)
            a.label.color = "0x7FB0FFFF"
        else
            a.label.text = tv_money(tv_countValue(a.from, a.to, t))
            keep.Push(a)
        end if
    end for
    m.anims = keep
    if keep.Count() = 0 then m.countTimer.control = "stop"
end sub

sub addRow(i as integer, r as object, y as integer, arrow as string)
    card = CreateObject("roSGNode", "Rectangle")
    card.translation = [100, y]
    card.width = 1720
    card.height = 102
    if i = 0
        card.color = "0x1A2A4DFF"
    else
        card.color = "0x111A30FF"
    end if
    m.rowsGroup.appendChild(card)
    stripe = CreateObject("roSGNode", "Rectangle")
    stripe.translation = [100, y]
    stripe.width = 8
    stripe.height = 102
    stripe.color = rankColor(i)
    m.rowsGroup.appendChild(stripe)

    rank = makeLabel(122, y + 14, 60, 76, (i + 1).ToStr(), "bold", 52, rankColor(i))
    rank.horizAlign = "center"
    m.rowsGroup.appendChild(rank)
    if arrow <> ""
        a = CreateObject("roSGNode", "Poster")
        if arrow = "up"
            a.uri = "pkg:/images/arrow_up.png"
            a.blendColor = "0x22C55EFF"
        else
            a.uri = "pkg:/images/arrow_down.png"
            a.blendColor = "0xEF4444FF"
        end if
        a.translation = [188, y + 38]
        a.width = 26
        a.height = 26
        a.loadDisplayMode = "scaleToFit"
        m.rowsGroup.appendChild(a)
    end if

    pid = tv_photoId(r)
    if pid <> "" and m.display.photos and m.havePhoto.DoesExist(pid)
        ' the rep's own photo (already cut into a circle), in a ring of their color
        ring = CreateObject("roSGNode", "Poster")
        ring.uri = "pkg:/images/circle.png"
        ring.translation = [222, y + 5]
        ring.width = 92
        ring.height = 92
        ring.loadDisplayMode = "scaleToFit"
        if r.color <> invalid then ring.blendColor = r.color else ring.blendColor = "0x3B82F6FF"
        m.rowsGroup.appendChild(ring)
        photo = CreateObject("roSGNode", "Poster")
        photo.uri = tv_photoPath(pid)
        photo.translation = [226, y + 9]
        photo.width = 84
        photo.height = 84
        photo.loadDisplayMode = "scaleToFit"
        m.rowsGroup.appendChild(photo)
        print "TV> avatar photo " + r.name
    else
        badge = CreateObject("roSGNode", "Poster")
        badge.uri = "pkg:/images/circle.png"
        badge.translation = [226, y + 9]
        badge.width = 84
        badge.height = 84
        badge.loadDisplayMode = "scaleToFit"
        if r.color <> invalid then badge.blendColor = r.color else badge.blendColor = "0x3B82F6FF"
        m.rowsGroup.appendChild(badge)
        ini = r.initials
        if ini = invalid then ini = "?"
        initials = makeLabel(226, y + 9, 84, 84, ini, "semibold", 36, "0xFFFFFFFF")
        initials.horizAlign = "center"
        initials.vertAlign = "center"
        m.rowsGroup.appendChild(initials)
    end if

    hasGoal = (tv_goalPct(r.goal) >= 0)
    if hasGoal
        m.rowsGroup.appendChild(makeLabel(338, y - 2, 560, 64, r.name, "bold", 46, "0xF2F5FBFF"))
        pct = tv_goalPct(r.goal)
        track = CreateObject("roSGNode", "Rectangle")
        track.translation = [338, y + 62]
        track.width = 420
        track.height = 14
        track.color = "0x25324FFF"
        m.rowsGroup.appendChild(track)
        fillW = tv_barWidth(pct, 420)
        if fillW > 0
            fill = CreateObject("roSGNode", "Rectangle")
            fill.translation = [338, y + 62]
            fill.width = fillW
            fill.height = 14
            fill.color = tv_goalColor(pct)
            m.rowsGroup.appendChild(fill)
        end if
        m.rowsGroup.appendChild(makeLabel(776, y + 52, 160, 34, tv_pctText(r.goal), "semibold", 26, tv_goalColor(pct)))
        m.rowsGroup.appendChild(makeLabel(338, y + 78, 620, 24, tv_goalText(r.goal), "semibold", 18, "0x8393B2FF"))
    else
        m.rowsGroup.appendChild(makeLabel(338, y + 12, 600, 70, r.name, "bold", 50, "0xF2F5FBFF"))
    end if

    m.rowsGroup.appendChild(makeLabel(960, y + 6, 340, 26, "CLOSING TODAY", "semibold", 20, "0x8393B2FF"))
    amt = makeLabel(960, y + 15, 400, 70, tv_money(r.closedCents), "bold", 50, "0x7FB0FFFF")
    m.rowsGroup.appendChild(amt)
    m.amountLabels[r.name] = amt
    deals = "deals"
    if r.closeCount = 1 then deals = "deal"
    m.rowsGroup.appendChild(makeLabel(960, y + 74, 340, 28, r.closeCount.ToStr() + " " + deals, "semibold", 22, "0xB4C0D8FF"))

    m.rowsGroup.appendChild(makeLabel(1440, y + 6, 340, 26, "ARRIVED TODAY", "semibold", 20, "0x8393B2FF"))
    m.rowsGroup.appendChild(makeLabel(1440, y + 15, 340, 70, r.arrivedCount.ToStr(), "bold", 50, "0xF2F5FBFF"))
    if m.display.commission then m.rowsGroup.appendChild(makeLabel(1440, y + 74, 340, 28, tv_money(r.commissionCents) + " commission", "semibold", 22, "0x5BD68AFF"))
end sub

function rankColor(i as integer) as string
    if i = 0 then return "0xE0B13AFF"
    if i = 1 then return "0xB8C0CCFF"
    if i = 2 then return "0xC47F4AFF"
    return "0x4A5B80FF"
end function

function makeLabel(x as integer, y as integer, w as integer, h as integer, text as string, weight as string, size as integer, color as string) as object
    lbl = CreateObject("roSGNode", "Label")
    lbl.translation = [x, y]
    lbl.width = w
    lbl.height = h
    lbl.text = text
    setFont(lbl, weight, size)
    lbl.color = color
    return lbl
end function

sub startConfetti()
    if not m.confettiOn then return
    m.confettiAnim.control = "stop"
    m.confetti.translation = [0, -1080]
    m.confetti.visible = true
    m.confettiAnim.control = "start"
    m.confettiTimer.control = "start"
    print "TV> confetti"
end sub

sub hideConfetti()
    m.confetti.visible = false
    m.confettiAnim.control = "stop"
end sub

' ---- the "Deal closed" banner, one at a time, with the deal's own sound ----
sub showNextBanner()
    if m.bannerBusy then return
    if m.queue.Count() = 0 then return
    m.bannerBusy = true
    c = m.queue.Shift()
    more = m.queue.Count()
    if c.isTest = true
        m.top.findNode("bannerBg").color = "0x2F6FEDFF"
        m.top.findNode("bannerTop").text = "SOUND TEST"
        m.top.findNode("bannerMain").text = "Playing a test sound..."
        m.top.findNode("bannerSub").text = "If you hear nothing, check the TV volume, then look at ROKU TV in the tracker's Settings"
        m.banner.visible = m.display.banner
        startConfetti()
        print "TV> banner SOUND TEST"
        playSound(c.sound, "test")
        m.bannerTimer.control = "start"
        return
    end if
    m.top.findNode("bannerBg").color = "0x1F9D55FF"
    m.top.findNode("bannerTop").text = "DEAL CLOSED"
    m.top.findNode("bannerMain").text = c.repName + " just closed " + tv_money(c.priceCents)
    detail = c.service
    if detail = invalid then detail = ""
    if c.location <> invalid and c.location <> ""
        if detail <> "" then detail = detail + "  -  " + c.location else detail = c.location
    end if
    if more > 0 then detail = detail + "   (+" + more.ToStr() + " more)"
    m.top.findNode("bannerSub").text = detail
    m.banner.visible = m.display.banner
    startConfetti()
    print "TV> banner " + c.repName + " " + tv_money(c.priceCents)
    playSound(c.sound, c.repName)
    m.bannerTimer.control = "start"
end sub

sub bannerDone()
    m.banner.visible = false
    m.bannerBusy = false
    showNextBanner()
end sub

sub playSound(sound as dynamic, label as string)
    if m.display.sound = false
        print "TV> sound is off in the menu"
        return
    end if
    path = tv_soundPath(sound, m.have)
    if path = ""
        print "TV> silent"
        return
    end if
    m.sndPath = path
    m.sndLabel = label
    m.sndAttempts = tv_attempts(m.soundMethod)
    m.sndTry = 0
    m.soundSeq = m.soundSeq + 1
    m.prevOutcome = m.lastOutcome        ' how the sound before this one went (kept for the reports: it shows whether a failure depends on what came before)
    m.prevGap = Int(Uptime(0) - m.lastSoundAt)
    m.lastOutcome = "pending"
    m.lastSoundAt = Uptime(0)
    stopPlayer()
    nextAttempt()
end sub

' a short note for the reports: which attempt this was, and how the previous sound went
function soundContext() as string
    return " [attempt " + m.sndTry.ToStr() + " of " + m.sndAttempts.Count().ToStr() + ", sound #" + m.soundSeq.ToStr() + " since the app started, the one before it: " + m.prevOutcome + " " + m.prevGap.ToStr() + "s earlier]"
end function

' The audio player is never reused: a player left in an error (or just-finished) state can refuse the next sound, so each attempt gets a brand new one
' and the old one is thrown away.
sub stopPlayer()
    if m.audio = invalid then return
    m.audio.unobserveField("state")
    m.audio.control = "stop"
    if m.audio.getParent() <> invalid then m.top.removeChild(m.audio)
    m.audio = invalid
end sub

' Tries the ways of playing a sound one after another until one works. Whatever happens is reported to the tracker so it can be seen from there.
sub nextAttempt()
    m.soundTimer.control = "stop"
    if m.sndTry >= m.sndAttempts.Count()
        m.lastOutcome = "failed"
        showDiag("Could not play the sound for " + m.sndLabel)
        report("sound_failed", m.sndPath + " (every way failed)" + soundContext())
        print "TV> sound failed " + m.sndPath
        return
    end if
    a = m.sndAttempts[m.sndTry]
    m.sndTry = m.sndTry + 1
    if a.method = "effects"
        stopPlayer()            ' let go of the audio player first, so it isn't holding the sound output
        res = CreateObject("roAudioResource", m.sndPath)
        if res = invalid
            print "TV> could not open(effects) " + m.sndPath
            report("sound_error", "sound-effects player could not open " + m.sndPath + soundContext())
            nextAttempt()
            return
        end if
        ok = res.Trigger(m.volume)
        m.player = res
        print "TV> play(effects) " + m.sndPath + " volume=" + m.volume.ToStr()
        if ok = invalid or ok
            m.lastOutcome = "ok"
            showDiag("Played " + m.sndLabel + " (sound-effects player)")
            report("sound_ok", m.sndPath + " via the sound-effects player, volume " + m.volume.ToStr() + soundContext())
        else
            report("sound_error", "sound-effects player would not start " + m.sndPath + soundContext())
            nextAttempt()
        end if
    else
        stopPlayer()
        content = CreateObject("roSGNode", "ContentNode")
        content.url = m.sndPath
        if a.fmt <> "" then content.streamFormat = a.fmt
        node = CreateObject("roSGNode", "Audio")
        m.audioMade = m.audioMade + 1
        node.observeField("state", "onAudioState")
        m.top.appendChild(node)
        node.content = content
        m.audio = node
        print "TV> new audio player #" + m.audioMade.ToStr()
        node.control = "play"
        m.soundTimer.control = "start"
        print "TV> play(player) " + m.sndPath + " format=[" + a.fmt + "]"
    end if
end sub

sub onAudioState(event as object)
    node = event.getRoSGNode()
    if m.audio = invalid then return
    if not node.isSameNode(m.audio) then return          ' a late message from a player we already threw away
    st = node.state
    print "TV> audio state=" + st
    if st = "playing"
        m.soundTimer.control = "stop"
        m.lastOutcome = "ok"
        showDiag("Played " + m.sndLabel + " (audio player)")
        report("sound_ok", m.sndPath + " via the audio player" + soundContext())
    else if st = "error"
        m.soundTimer.control = "stop"
        report("sound_error", "audio player error on " + m.sndPath + ": " + tv_text(node.errorMsg) + " code " + tv_text(node.errorCode) + soundContext())
        stopPlayer()
        nextAttempt()
    else if st = "finished"
        stopPlayer()
    end if
end sub

sub onSoundTimeout()
    print "TV> audio player never started"
    report("sound_timeout", "audio player never started " + m.sndPath + soundContext())
    stopPlayer()
    nextAttempt()
end sub

sub showDiag(text as string)
    m.diagLabel.text = text
    m.diagTimer.control = "start"
end sub

sub clearDiag()
    m.diagLabel.text = ""
end sub

' ---- reports to the tracker, one at a time ----
sub report(event as string, detail as string)
    if m.cfg = invalid then return
    if m.reportQueue.Count() > 20 then m.reportQueue.Shift()
    m.reportQueue.Push({ event: event, detail: detail })
    print "TV> report queued: " + event
    sendNextReport()
end sub

sub sendNextReport()
    if m.reporting
        if Uptime(0) - m.reportStarted < 30 then return
        print "TV> a report took too long, moving on"
        m.reporting = false
    end if
    if m.reportQueue.Count() = 0 then return
    r = m.reportQueue.Shift()
    m.reporting = true
    m.reportStarted = Uptime(0)
    task = CreateObject("roSGNode", "ReportTask")
    task.observeField("result", "onReported")
    task.url = m.cfg.server + "/api/tv/report"
    task.key = m.cfg.key
    task.body = FormatJson(r)
    m.reportTask = task
    task.control = "RUN"
end sub

sub onReported(event as object)
    task = event.getRoSGNode()
    if m.reportTask = invalid then return
    if not task.isSameNode(m.reportTask) then return
    m.reporting = false
    print "TV> report sent"
    sendNextReport()
end sub

' ---- the owner's own sounds: fetched one at a time and kept until the app closes ----
sub startDownloads()
    if m.downloading
        if Uptime(0) - m.dlStarted < 60 then return
        print "TV> download took too long, moving on"
        m.downloading = false
    end if
    if m.wanted.Count() = 0 then return
    item = m.wanted.Shift()
    m.dlId = item.id
    m.dlKind = item.kind
    m.downloading = true
    m.dlStarted = Uptime(0)
    task = CreateObject("roSGNode", "DownloadTask")
    task.observeField("result", "onDownloaded")
    task.key = m.cfg.key
    if item.kind = "photo"
        task.url = m.cfg.server + "/api/tv/photo/" + item.id
        task.path = tv_photoPath(item.id)
    else
        task.url = m.cfg.server + "/api/tv/sound/" + item.id
        task.path = "tmp:/tv_" + item.id + ".wav"
    end if
    m.dlTask = task
    task.control = "RUN"
end sub

sub onDownloaded(event as object)
    task = event.getRoSGNode()
    if m.dlTask = invalid then return
    if not task.isSameNode(m.dlTask) then return
    r = event.getData()
    m.downloading = false
    kind = m.dlKind
    id = m.dlId
    m.dlId = ""
    m.dlKind = ""
    if r <> invalid and r.ok
        if kind = "photo"
            m.havePhoto[id] = true
            print "TV> photo ready " + id
            m.rowsSig = "(a photo arrived)"          ' so the rows are drawn again, now with the photo
            if m.lastRows <> invalid then renderRows(m.lastRows)
        else
            m.have[id] = true
            print "TV> sound ready " + id
        end if
    else
        print "TV> " + kind + " download failed " + id
    end if
    startDownloads()
end sub


' ====================================================================================== LAYOUTS, THE DISPLAY MENU AND THE REMOTE
function loadDisplay() as dynamic
    sec = CreateObject("roRegistrySection", "sbn_display")
    if sec.Exists("d") then return ParseJson(sec.Read("d"))
    return invalid
end function

sub saveDisplay()
    sec = CreateObject("roRegistrySection", "sbn_display")
    sec.Write("d", FormatJson(m.display))
    sec.Flush()
end sub

function tv_menuVolume(name as string) as integer
    if name = "low" then return 40
    if name = "high" then return 100
    return 70
end function

sub clearGroup(g as object)
    n = g.getChildCount()
    if n > 0 then g.removeChildrenIndex(n, 0)
end sub

' turns a list of things to draw (see layouts.brs) into real nodes
sub buildItems(group as object, items as object)
    for each it in items
        if it.t = "r"
            n = CreateObject("roSGNode", "Rectangle")
            n.translation = [it.x, it.y]
            n.width = it.w
            n.height = it.h
            n.color = it.c
            group.appendChild(n)
        else if it.t = "p"
            n = CreateObject("roSGNode", "Poster")
            n.uri = it.u
            n.translation = [it.x, it.y]
            n.width = it.w
            n.height = it.h
            n.loadDisplayMode = "scaleToFit"
            if it.b <> invalid and it.b <> "" then n.blendColor = it.b
            group.appendChild(n)
        else if it.t = "l"
            n = makeLabel(it.x, it.y, it.w, it.h, it.s, it.wt, it.sz, it.c)
            n.horizAlign = it.al
            n.vertAlign = it.va
            group.appendChild(n)
        end if
    end for
end sub

' the Classic board is drawn by the scene's own nodes; every other layout is drawn into the stage
sub applyLayoutChrome()
    classic = (m.currentLayout = "classic")
    for each id in ["title", "subtitle", "accent", "rows", "tile0panel", "tile0bar", "tile0cap", "tile0amt", "tile0sub", "tile1panel", "tile1bar", "tile1cap", "tile1amt", "tile1sub"]
        n = m.top.findNode(id)
        if n <> invalid then n.visible = classic
    end for
    showTile2 = classic and m.display.commission
    for each id in ["tile2panel", "tile2bar", "tile2cap", "tile2amt", "tile2sub"]
        n = m.top.findNode(id)
        if n <> invalid then n.visible = showTile2
    end for
    if not classic then m.emptyLabel.visible = false
    m.stageGroup.visible = not classic
end sub

sub drawBoard()
    if m.lastFeed = invalid then return
    applyLayoutChrome()
    if m.currentLayout = "classic"
        m.logoNode.opacity = 1.0
        m.clockLabel.color = "0xA9BBDCFF"
        rows = m.lastFeed.rows
        if rows = invalid then rows = []
        renderRows(rows)
    else
        drawStage()
    end if
end sub

sub drawStage()
    if m.lastFeed = invalid then return
    st = tv_stage(m.currentLayout, m.lastFeed, m.display, m.havePhoto, m.tick)
    clearGroup(m.stageGroup)
    buildItems(m.stageGroup, st.items)
    if st.dim
        m.logoNode.opacity = 0.4
        m.clockLabel.color = "0x5A6A8CFF"
    else
        m.logoNode.opacity = 1.0
        m.clockLabel.color = "0xA9BBDCFF"
    end if
end sub

sub setLayout(id as string)
    m.currentLayout = id
    if id = "classic" then m.rowsSig = "(nothing drawn yet)"      ' the classic rows were not kept up to date while hidden: draw them again
    drawBoard()
end sub

' ---- rotation ----
sub startRotation()
    m.rotateTimer.control = "stop"
    if m.display.rotate and m.display.layouts.Count() > 1
        m.rotateTimer.duration = m.display.rotateSeconds
        m.rotateTimer.control = "start"
    else if m.currentLayout <> m.display.layout
        setLayout(m.display.layout)
    end if
end sub

sub onRotate()
    if m.menuOpen then return
    if not m.display.rotate then return
    setLayout(tv_rotateNext(m.display, m.currentLayout))
end sub

' ---- settings coming from the tracker (a change made on the phone) ----
sub applyServerDisplay(raw as object)
    if m.menuOpen then return
    if Uptime(0) - m.localChangeAt < 20 then return       ' a change just made here is still on its way to the tracker: don't let an older answer undo it
    nd = tv_cleanDisplay(raw)
    changed = tv_changed(m.display, nd)
    if changed.Count() = 0 then return
    m.display = nd
    saveDisplay()
    onDisplayChanged(changed)
end sub

sub onDisplayChanged(changed as object)
    if changed.confetti <> invalid then m.confettiOn = m.display.confetti
    if changed.volume <> invalid then m.volume = tv_menuVolume(m.display.volume)
    if changed.photos <> invalid or changed.commission <> invalid or changed.textSize <> invalid then m.rowsSig = "(nothing drawn yet)"
    if changed.layout <> invalid
        setLayout(m.display.layout)
    else
        drawBoard()
    end if
    if changed.rotate <> invalid or changed.rotateSeconds <> invalid or changed.layouts <> invalid or changed.layout <> invalid then startRotation()
end sub

' ---- changes made with the remote ----
sub changeDisplay(nd as object)
    changed = tv_changed(m.display, nd)
    if changed.Count() = 0 then return
    m.display = nd
    saveDisplay()
    m.localChangeAt = Uptime(0)
    for each k in changed
        m.pending[k] = changed[k]
    end for
    m.sendTimer.control = "stop"
    m.sendTimer.control = "start"
    onDisplayChanged(changed)
end sub

' a short pause after the last key press, then everything that changed goes to the tracker in one message
sub flushDisplay()
    if m.cfg = invalid then return
    if m.pending.Count() = 0 then return
    task = CreateObject("roSGNode", "ReportTask")
    task.observeField("result", "onDisplaySent")
    task.url = m.cfg.server + "/api/tv/display"
    task.key = m.cfg.key
    task.body = FormatJson(m.pending)
    m.pending = {}
    m.displayTasks.Push(task)
    if m.displayTasks.Count() > 6 then m.displayTasks.Shift()
    task.control = "RUN"
    print "TV> display settings sent"
end sub

sub onDisplaySent(event as object)
    r = event.getData()
    if r <> invalid and r.ok = false then print "TV> the tracker did not take the display settings"
end sub

' ---- the menu ----
sub openMenu()
    m.menuOpen = true
    m.menuSel = 0
    m.menuGroup.visible = true
    drawMenu()
end sub

sub closeMenu()
    m.menuOpen = false
    m.menuGroup.visible = false
    clearGroup(m.menuGroup)
end sub

sub drawMenu()
    clearGroup(m.menuGroup)
    buildItems(m.menuGroup, tv_menuStage(m.display, m.menuSel))
end sub

' the remote: * opens and closes the menu; while it is open the arrows move through it, OK selects and Back closes it
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "options"
        if m.menuOpen then closeMenu() else openMenu()
        return true
    end if
    if not m.menuOpen then return false
    rows = tv_menuRows(m.display)
    if key = "up"
        m.menuSel = tv_menuMove(m.menuSel, -1, rows.Count())
    else if key = "down"
        m.menuSel = tv_menuMove(m.menuSel, 1, rows.Count())
    else if key = "left"
        changeDisplay(tv_menuChange(m.display, rows[m.menuSel].key, -1))
    else if key = "right"
        changeDisplay(tv_menuChange(m.display, rows[m.menuSel].key, 1))
    else if key = "OK"
        changeDisplay(tv_menuAction(m.display, rows[m.menuSel].key))
    else if key = "back"
        closeMenu()
        return true
    end if
    drawMenu()
    return true
end function
