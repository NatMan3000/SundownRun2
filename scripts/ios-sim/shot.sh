#!/bin/bash
# usage: shot.sh <url-or-empty> <out.png>   (opens the url in Safari, waits 4 s, screenshots; empty url = shoot what is there)
. "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
[ -n "$1" ] && { xcrun simctl openurl "$SIM_UDID" "$1"; sleep 4; }
xcrun simctl io "$SIM_UDID" screenshot "$2" >/dev/null 2>&1
echo "$2: $(sips -g pixelWidth -g pixelHeight "$2" | awk '/pixel/{printf $2" "}')"
