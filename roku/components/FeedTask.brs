' Fetches the leaderboard feed from the tracker. Runs off the main thread, so a slow network never freezes the screen.
sub init()
    m.seq = 0
    m.top.functionName = "doFetch"
end sub

sub doFetch()
    m.seq = m.seq + 1
    url = m.top.url
    req = CreateObject("roUrlTransfer")
    req.SetUrl(url)
    req.AddHeader("X-TV-Key", m.top.key)
    if Left(url, 5) = "https"
        req.SetCertificatesFile("common:/certs/ca-bundle.crt")
        req.InitClientCertificates()
    end if
    port = CreateObject("roMessagePort")
    req.SetMessagePort(port)
    if req.AsyncGetToString()
        msg = wait(12000, port)
        if type(msg) = "roUrlEvent"
            code = msg.GetResponseCode()
            if code = 200
                data = ParseJson(msg.GetString())
                if data <> invalid
                    m.top.result = { ok: true, data: data, code: code, seq: m.seq }
                    return
                end if
            end if
            m.top.result = { ok: false, code: code, seq: m.seq }
            return
        end if
        req.AsyncCancel()
    end if
    m.top.result = { ok: false, code: 0, seq: m.seq }
end sub
