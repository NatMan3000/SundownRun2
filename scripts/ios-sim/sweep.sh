#!/bin/bash
# Real Safari on the simulator, one state at a time, Safari restarted between them so tabs don't pile up.
# usage: sweep.sh [steps-file]      (steps on stdin if the file is "-")
# A step is one line:  name  query  [wait-seconds=16]  [shots=1]
#   name   -> $IOS_SIM_OUT/sweep/<name>.png (or <name>-1.png ... when shots > 1)
#   query  -> appended to the game URL, served by sweep-server.ts (sweep=<screen>&tab=<tab>, hud=<scene>, after=<ms>)
#   shots  -> a burst, BURST_GAP seconds apart (default 1), for states that fade: a countdown, a toast, a trap
# env: SWEEP_PORT (5223), SWEEP_BASE (the game URL up to the query), BURST_GAP
. "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
O="$IOS_SIM_OUT/sweep"; mkdir -p "$O"
B="${SWEEP_BASE:-http://localhost:${SWEEP_PORT:-5223}/?nomusic=1&track=afterglow&mode=free}"
go() {
  xcrun simctl terminate "$SIM_UDID" com.apple.mobilesafari >/dev/null 2>&1; sleep 1
  xcrun simctl openurl "$SIM_UDID" "$B&$2"; sleep "${3:-16}"
  if [ "${4:-1}" -le 1 ]; then xcrun simctl io "$SIM_UDID" screenshot "$O/$1.png" >/dev/null 2>&1
  else for i in $(seq 1 "$4"); do xcrun simctl io "$SIM_UDID" screenshot "$O/$1-$i.png" >/dev/null 2>&1; sleep "${BURST_GAP:-1}"; done; fi
  echo "$1 done"
}
default_steps() { cat <<'S'
title sweep=title
mode sweep=mode
track sweep=track
garage sweep=garage
settings-car sweep=settings&tab=car
settings-handling sweep=settings&tab=handling
settings-audio sweep=settings&tab=audio
settings-mp sweep=settings&tab=multiplayer
pause sweep=pause
results sweep=results
report sweep=report
hud-tag hud=tag
hud-turns hud=turns
hud-countdown hud=countdown&after=6000 9 6
hud-tricks hud=tricks
hud-toasts hud=toasts&after=6000 9 6
hud-trap hud=trap&after=6000 9 6
S
}
if [ -n "$1" ]; then if [ "$1" = "-" ]; then cat; else cat "$1"; fi; else default_steps; fi | while read -r name query wait shots; do
  [ -z "$name" ] && continue
  go "$name" "$query" "$wait" "$shots"
done
echo finished
