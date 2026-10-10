' Tells the tracker what the TV is doing (what it started on, which sound it tried, whether that worked), so a silent TV can be diagnosed from the tracker.
sub init()
    m.seq = 0
    m.top.functionName = "doPost"
end sub

sub doPost()
    m.seq = m.seq + 1
    url = m.top.url
    req = CreateObject("roUrlTransfer")
    req.SetUrl(url)
    req.AddHeader("X-TV-Key", m.top.key)
    req.AddHeader("Content-Type", "application/json")
    if Left(url, 5) = "https"
        req.SetCertificatesFile("common:/certs/ca-bundle.crt")
        req.InitClientCertificates()
    end if
    port = CreateObject("roMessagePort")
    req.SetMessagePort(port)
    if req.AsyncPostFromString(m.top.body)
        msg = wait(10000, port)
        if type(msg) = "roUrlEvent"
            m.top.result = { ok: (msg.GetResponseCode() = 200), seq: m.seq }
            return
        end if
        req.AsyncCancel()
    end if
    m.top.result = { ok: false, seq: m.seq }
end sub
