' Downloads one of the owner's own sounds to the TV's temporary storage so it can play instantly when a deal closes.
sub init()
    m.seq = 0
    m.top.functionName = "doDownload"
end sub

sub doDownload()
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
    if req.AsyncGetToFile(m.top.path)
        msg = wait(30000, port)
        if type(msg) = "roUrlEvent"
            m.top.result = { ok: (msg.GetResponseCode() = 200), code: msg.GetResponseCode(), seq: m.seq }
            return
        end if
        req.AsyncCancel()
    end if
    m.top.result = { ok: false, code: 0, seq: m.seq }
end sub
