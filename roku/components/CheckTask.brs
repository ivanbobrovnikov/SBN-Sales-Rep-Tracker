' Checks each sound file inside the installed app against what the tracker says it should be (its size, and the total of all its bytes), so a damaged
' file shows up in the tracker's report list. Runs in the background: adding up thousands of bytes would otherwise freeze the screen for a moment.
sub init()
    m.top.functionName = "doCheck"
end sub

sub doCheck()
    out = {}
    for each key in m.top.files
        want = m.top.files[key]
        ba = CreateObject("roByteArray")
        if not ba.ReadFile("pkg:/sounds/" + key + ".wav")
            out[key] = "UNREADABLE: the file is missing or the Roku could not open it"
        else
            n = ba.Count()
            ' (adding up every byte is slow on a TV, so it adds up every 16th byte, and the 44-byte header exactly)
            sum16 = 0
            for i = 0 to n - 1 step 16
                sum16 = sum16 + ba[i]
            end for
            head = 0
            for i = 0 to 43
                if i < n then head = head + ba[i]
            end for
            tag = ""
            if n >= 12
                tag = Chr(ba[0]) + Chr(ba[1]) + Chr(ba[2]) + Chr(ba[3]) + "/" + Chr(ba[8]) + Chr(ba[9]) + Chr(ba[10]) + Chr(ba[11])
            end if
            if n = want.size and sum16 = want.sum16 and head = want.head
                out[key] = "intact, " + n.ToStr() + " bytes, header " + tag
            else
                why = ""
                if n <> want.size then why = why + n.ToStr() + " bytes (should be " + want.size.ToStr() + "); "
                if head <> want.head then why = why + "the header is different; "
                if sum16 <> want.sum16 then why = why + "the contents are different (sampled total " + sum16.ToStr() + ", should be " + want.sum16.ToStr() + "); "
                out[key] = "DIFFERENT from what was sent: " + why + "header " + tag
            end if
        end if
    end for
    m.top.result = out
end sub
