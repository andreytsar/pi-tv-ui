-- Automatically select the best HLS/video track with height <= 720p
-- and sync its matching audio variant so mpv doesn't download a 1080p stream just for audio.

local MAX_HEIGHT = 720

local function select_max_720p()
    local tracks = mp.get_property_native("track-list")
    if not tracks then return end

    local best_under = nil
    local lowest_over = nil

    for _, t in ipairs(tracks) do
        if t.type == "video" and not t.albumart then
            local h = t["demux-h"] or 0
            local br = t["hls-bitrate"] or t["demux-bitrate"] or 0
            if h > 0 and h <= MAX_HEIGHT then
                if not best_under
                   or h > (best_under["demux-h"] or 0)
                   or (h == (best_under["demux-h"] or 0) and br > (best_under["hls-bitrate"] or best_under["demux-bitrate"] or 0)) then
                    best_under = t
                end
            elseif h > MAX_HEIGHT then
                if not lowest_over
                   or h < (lowest_over["demux-h"] or 99999)
                   or (h == (lowest_over["demux-h"] or 99999) and br < (lowest_over["hls-bitrate"] or lowest_over["demux-bitrate"] or 1e12)) then
                    lowest_over = t
                end
            end
        end
    end

    local chosen = best_under or lowest_over
    if not chosen then return end

    if not chosen.selected then
        mp.set_property_number("vid", chosen.id)
        mp.msg.info(string.format("max720p: selected vid=%d (%dx%d)",
            chosen.id, chosen["demux-w"] or 0, chosen["demux-h"] or 0))
    end

    -- Sync matching HLS variant audio track so mpv doesn't fetch a 1080p stream just for audio
    local vbr = chosen["hls-bitrate"] or chosen["demux-bitrate"]
    if vbr and vbr > 0 then
        for _, t in ipairs(tracks) do
            if t.type == "audio" and (t["hls-bitrate"] or t["demux-bitrate"]) == vbr then
                if not t.selected then
                    mp.set_property_number("aid", t.id)
                    mp.msg.info(string.format("max720p: synced aid=%d (bitrate=%d)", t.id, vbr))
                end
                break
            end
        end
    end
end

mp.register_event("file-loaded", select_max_720p)
