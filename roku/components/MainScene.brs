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
    m.audio = m.top.findNode("audioPlayer")
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
    m.testSeq = invalid
    m.sndPath = ""
    m.sndLabel = ""
    m.sndAttempts = []
    m.sndTry = 0
    m.reportQueue = []
    m.reporting = false
    m.pollTimer.observeField("fire", "pollNow")
    m.clockTimer.observeField("fire", "tickClock")
    m.bannerTimer.observeField("fire", "bannerDone")
    m.diagTimer.observeField("fire", "clearDiag")
    m.soundTimer.observeField("fire", "onSoundTimeout")
    m.audio.observeField("state", "onAudioState")
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
    report("started", "SBN Leaderboard 1.1 on " + tv_text(di.GetModelDisplayName()) + " (" + tv_text(di.GetModel()) + ") Roku OS " + osText)
    pollNow()
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
    if c.isTest = true
        m.top.findNode("bannerBg").color = "0x2F6FEDFF"
        m.top.findNode("bannerTop").text = "SOUND TEST"
        m.top.findNode("bannerMain").text = "Playing a test sound..."
        m.top.findNode("bannerSub").text = "If you hear nothing, check the TV volume, then look at ROKU TV in the tracker's Settings"
        m.banner.visible = true
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
    nextAttempt()
end sub

' Tries the ways of playing a sound one after another until one works. Whatever happens is reported to the tracker so it can be seen from there.
sub nextAttempt()
    m.soundTimer.control = "stop"
    if m.sndTry >= m.sndAttempts.Count()
        showDiag("Could not play the sound for " + m.sndLabel)
        report("sound_failed", m.sndPath + " (every way failed)")
        print "TV> sound failed " + m.sndPath
        return
    end if
    a = m.sndAttempts[m.sndTry]
    m.sndTry = m.sndTry + 1
    if a.method = "effects"
        res = CreateObject("roAudioResource", m.sndPath)
        if res = invalid
            print "TV> could not open(effects) " + m.sndPath
            report("sound_error", "sound-effects player could not open " + m.sndPath)
            nextAttempt()
            return
        end if
        ok = res.Trigger(m.volume)
        m.player = res
        print "TV> play(effects) " + m.sndPath + " volume=" + m.volume.ToStr()
        if ok = invalid or ok
            showDiag("Played " + m.sndLabel + " (sound-effects player)")
            report("sound_ok", m.sndPath + " via the sound-effects player, volume " + m.volume.ToStr())
        else
            report("sound_error", "sound-effects player would not start " + m.sndPath)
            nextAttempt()
        end if
    else
        content = CreateObject("roSGNode", "ContentNode")
        content.url = m.sndPath
        if a.fmt <> "" then content.streamFormat = a.fmt
        m.audio.control = "stop"
        m.audio.content = content
        m.audio.control = "play"
        m.soundTimer.control = "start"
        print "TV> play(player) " + m.sndPath + " format=[" + a.fmt + "]"
    end if
end sub

sub onAudioState()
    st = m.audio.state
    print "TV> audio state=" + st
    if st = "playing"
        m.soundTimer.control = "stop"
        showDiag("Played " + m.sndLabel + " (audio player)")
        report("sound_ok", m.sndPath + " via the audio player")
    else if st = "error"
        m.soundTimer.control = "stop"
        report("sound_error", "audio player error on " + m.sndPath + ": " + tv_text(m.audio.errorMsg) + " code " + tv_text(m.audio.errorCode))
        nextAttempt()
    end if
end sub

sub onSoundTimeout()
    print "TV> audio player never started"
    report("sound_timeout", "audio player never started " + m.sndPath)
    m.audio.control = "stop"
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
