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
        sig = sig + r.name + "|" + tv_text(r.closedCents) + "|" + tv_text(r.arrivedCount) + "|" + tv_text(r.commissionCents) + "|" + tv_text(r.closeCount) + "|" + p.ToStr() + "|" + tv_arrowFor(m.rankState, r.name, now) + ";"
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
    m.rowsGroup.appendChild(makeLabel(1440, y + 74, 340, 28, tv_money(r.commissionCents) + " commission", "semibold", 22, "0x5BD68AFF"))
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
        m.banner.visible = true
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
    m.banner.visible = true
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
        print "TV> sound download took too long, moving on"
        m.downloading = false
    end if
    if m.wanted.Count() = 0 then return
    m.dlId = m.wanted.Shift()
    m.downloading = true
    m.dlStarted = Uptime(0)
    task = CreateObject("roSGNode", "DownloadTask")
    task.observeField("result", "onDownloaded")
    task.url = m.cfg.server + "/api/tv/sound/" + m.dlId
    task.key = m.cfg.key
    task.path = "tmp:/tv_" + m.dlId + ".wav"
    m.dlTask = task
    task.control = "RUN"
end sub

sub onDownloaded(event as object)
    task = event.getRoSGNode()
    if m.dlTask = invalid then return
    if not task.isSameNode(m.dlTask) then return
    r = event.getData()
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
