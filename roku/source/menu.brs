
' ====================================================================================== THE DISPLAY MENU (press * on the Roku remote)
' Settings, moving through the menu, and drawing it are all plain functions here, so they can be tested away from a TV.
function tv_displayDefaults() as object
    return { layout: "classic", rotate: false, rotateSeconds: 30, layouts: tv_layoutIds(), photos: true, commission: true, banner: true, sound: true, textSize: "normal", confetti: true, volume: "medium" }
end function

function L_inList(list as object, item as dynamic) as boolean
    for each x in list
        if x = item then return true
    end for
    return false
end function

function L_copyList(list as object) as object
    out = []
    for each x in list
        out.Push(x)
    end for
    return out
end function

function L_copy(d as object) as object
    out = {}
    for each k in d
        out[k] = d[k]
    end for
    if d.layouts <> invalid then out.layouts = L_copyList(d.layouts)
    return out
end function

' anything that arrives from the tracker or the TV's memory is checked before it is used, so a bad value can never blank the screen
' A true/false can reach the TV under two names: "Boolean", or "roBoolean" (the same thing, boxed, which is how values that come out of JSON can be reported on a real Roku). Both count.
function L_isBool(v as dynamic) as boolean
    t = type(v)
    return t = "Boolean" or t = "roBoolean"
end function

' Reads a true/false whichever kind it is. A boxed one (roBoolean) is read with its own GetBoolean(); a plain one is just compared.
function L_boolVal(v as dynamic) as boolean
    if type(v) = "roBoolean" then return v.GetBoolean()
    return v = true
end function

function tv_cleanDisplay(raw as dynamic) as object
    d = tv_displayDefaults()
    if raw = invalid then return d
    if type(raw) <> "roAssociativeArray" then return d
    if raw.layout <> invalid and L_inList(tv_layoutIds(), raw.layout) then d.layout = raw.layout
    if L_isBool(raw.rotate) then d.rotate = L_boolVal(raw.rotate)
    if L_isBool(raw.photos) then d.photos = L_boolVal(raw.photos)
    if L_isBool(raw.commission) then d.commission = L_boolVal(raw.commission)
    if L_isBool(raw.banner) then d.banner = L_boolVal(raw.banner)
    if L_isBool(raw.sound) then d.sound = L_boolVal(raw.sound)
    if L_isBool(raw.confetti) then d.confetti = L_boolVal(raw.confetti)
    if raw.textSize = "large" then d.textSize = "large"
    if raw.volume = "low" or raw.volume = "medium" or raw.volume = "high" then d.volume = raw.volume
    if raw.rotateSeconds <> invalid
        s = Int(raw.rotateSeconds)
        if s = 15 or s = 30 or s = 60 or s = 120 then d.rotateSeconds = s
    end if
    if raw.layouts <> invalid and type(raw.layouts) = "roArray"
        keep = []
        for each id in tv_layoutIds()
            for each x in raw.layouts
                if x = id then keep.Push(id)
            end for
        end for
        if keep.Count() > 0 then d.layouts = keep
    end if
    return d
end function

function L_onOff(b as dynamic) as string
    if b = true then return "On"
    return "Off"
end function

function L_secsText(s as integer) as string
    if s >= 120 then return "2 min"
    if s >= 60 then return "1 min"
    return s.ToStr() + " sec"
end function

function L_cap(s as string) as string
    return UCase(Left(s, 1)) + Mid(s, 2)
end function

' the rows of the menu, in order
function tv_menuRows(d as object) as object
    return [
        { key: "layout", label: "Layout", value: tv_layoutName(d.layout) },
        { key: "rotate", label: "Rotate between layouts", value: L_onOff(d.rotate) },
        { key: "rotateSeconds", label: "Rotate every", value: L_secsText(d.rotateSeconds) },
        { key: "photos", label: "Rep photos", value: L_onOff(d.photos) },
        { key: "commission", label: "Show commission", value: L_onOff(d.commission) },
        { key: "textSize", label: "Text size", value: L_cap(d.textSize) },
        { key: "banner", label: "Deal closed banner", value: L_onOff(d.banner) },
        { key: "confetti", label: "Confetti", value: L_onOff(d.confetti) },
        { key: "sound", label: "Sound", value: L_onOff(d.sound) },
        { key: "volume", label: "Volume", value: L_cap(d.volume) }
    ]
end function

function tv_menuMove(sel as integer, dir as integer, count as integer) as integer
    s = sel + dir
    if s < 0 then s = count - 1
    if s >= count then s = 0
    return s
end function

function L_cycle(list as object, current as dynamic, dir as integer) as dynamic
    idx = 0
    for i = 0 to list.Count() - 1
        if list[i] = current then idx = i
    end for
    idx = idx + dir
    if idx < 0 then idx = list.Count() - 1
    if idx >= list.Count() then idx = 0
    return list[idx]
end function

' Left (-1) / Right (+1) on a row. Returns a new settings object; the old one is untouched.
function tv_menuChange(d as object, key as string, dir as integer) as object
    n = L_copy(d)
    if key = "layout"
        n.layout = L_cycle(tv_layoutIds(), d.layout, dir)
    else if key = "rotateSeconds"
        n.rotateSeconds = L_cycle([15, 30, 60, 120], d.rotateSeconds, dir)
    else if key = "textSize"
        n.textSize = L_cycle(["normal", "large"], d.textSize, dir)
    else if key = "volume"
        n.volume = L_cycle(["low", "medium", "high"], d.volume, dir)
    else if L_isBool(d[key])
        n[key] = not L_boolVal(d[key])
    end if
    return n
end function

' OK on a row. On the Layout row it adds or removes the current layout from the rotation (there is always at least one); elsewhere it is the same as Right.
function tv_menuAction(d as object, key as string) as object
    if key <> "layout" then return tv_menuChange(d, key, 1)
    n = L_copy(d)
    if L_inList(d.layouts, d.layout)
        if d.layouts.Count() > 1
            keep = []
            for each x in d.layouts
                if x <> d.layout then keep.Push(x)
            end for
            n.layouts = keep
        end if
    else
        keep = []
        for each id in tv_layoutIds()
            if id = d.layout or L_inList(d.layouts, id) then keep.Push(id)
        end for
        n.layouts = keep
    end if
    return n
end function

' the next layout in the rotation after the one on screen
' the next layout in the rotation, skipping any that failed to draw on this TV. If every one has failed, the Classic board.
function tv_rotateNextGood(d as object, current as string, bad as object) as string
    nxt = current
    for i = 1 to d.layouts.Count()
        nxt = tv_rotateNext(d, nxt)
        if not bad.DoesExist(nxt) then return nxt
    end for
    return "classic"
end function

function tv_rotateNext(d as object, current as string) as string
    list = d.layouts
    if list.Count() = 0 then return current
    nxt = list[0]
    found = false
    for i = 0 to list.Count() - 1
        if found
            nxt = list[i]
            found = false
            exit for
        end if
        if list[i] = current then found = true
    end for
    if found then nxt = list[0]
    return nxt
end function

' only the settings that changed, ready to send to the tracker
function tv_changed(a as object, b as object) as object
    out = {}
    for each k in b
        if k = "layouts"
            if a.layouts.Count() <> b.layouts.Count()
                out.layouts = b.layouts
            else
                for i = 0 to a.layouts.Count() - 1
                    if a.layouts[i] <> b.layouts[i] then out.layouts = b.layouts
                end for
            end if
        else if a[k] <> b[k]
            out[k] = b[k]
        end if
    end for
    return out
end function

' drawing the menu: a dim sheet over the board, a panel with the nine layouts to choose from, and the settings underneath
function tv_menuStage(d as object, sel as integer) as object
    items = []
    items.Push(L_r(0, 0, 1920, 1080, "0x000000B8"))
    items.Push(L_r(330, 36, 1260, 1008, "0x0C1730FF"))
    items.Push(L_r(330, 36, 1260, 6, "0x3B82F6FF"))
    items.Push(L_t(380, 52, 700, 64, "DISPLAY", "0xF2F5FBFF", "bold", 52, "left", "center"))
    items.Push(L_t(1000, 62, 540, 44, "press * to close", "0x8393B2FF", "semibold", 26, "right", "center"))
    ids = tv_layoutIds()
    for i = 0 to ids.Count() - 1
        id = ids[i]
        x = 400 + (i mod 3) * 372
        y = 130 + (i \ 3) * 160
        cur = (id = d.layout)
        border = "0x25324FFF"
        if cur then border = "0x3B82F6FF"
        items.Push(L_r(x, y, 340, 148, border))
        items.Push(L_i(x + 4, y + 4, 332, 140, "pkg:/images/thumb_" + id + ".png", ""))
        items.Push(L_r(x + 4, y + 104, 332, 40, "0x070D1CD9"))
        items.Push(L_t(x + 12, y + 104, 240, 40, tv_layoutName(id), "0xF2F5FBFF", "semibold", 26, "left", "center"))
        if L_inList(d.layouts, id) and d.rotate then items.Push(L_t(x + 250, y + 104, 80, 40, "ROTATES", "0x3DDC97FF", "semibold", 18, "right", "center"))
    end for
    rows = tv_menuRows(d)
    for i = 0 to rows.Count() - 1
        y = 618 + i * 38
        if i = sel
            items.Push(L_r(380, y, 1160, 36, "0x1A2A4DFF"))
            items.Push(L_r(380, y, 6, 36, "0x3B82F6FF"))
        end if
        items.Push(L_t(404, y, 560, 36, rows[i].label, "0xF2F5FBFF", "semibold", 26, "left", "center"))
        v = rows[i].value
        if i = sel then v = "<   " + v + "   >"
        vc = "0x7FA8FFFF"
        if rows[i].value = "Off" then vc = "0x8393B2FF"
        items.Push(L_t(1000, y, 520, 36, v, vc, "semibold", 26, "right", "center"))
    end for
    hint = "Up / Down: choose     Left / Right: change     Back: close"
    if sel = 0 then hint = "Left / Right: pick a layout     OK: add or remove it from the rotation     Back: close"
    items.Push(L_t(380, 1004, 1160, 30, hint, "0x6F7C96FF", "semibold", 22, "center", "center"))
    return items
end function
