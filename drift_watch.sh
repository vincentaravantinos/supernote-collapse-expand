#!/usr/bin/env bash
#
# drift_watch.sh — live ledger of the Supernote note-app trail-cache desync.
#
# Each collapse/expand/recollapse prints one row showing the note app's OWN
# counters:
#   existTrails    — note-side plugin trail cache (PluginClientCommImpl
#                    "insert PageTrails exist Trails:N"). LEAKS: climbs with
#                    every insert, never shrinks on delete.
#   jniContainers  — same cache as seen by getNotePageData ("jniTrailContainers
#                    size:N").
#   mTrailNumber   — the LIVE render model (NotePresenter "mTrailNumber N").
#                    Stays flat/correct.
#   inserted       — note-side "insertCount:N" for that action.
#
# Watch existTrails / jniContainers climb while mTrailNumber stays flat. The
# first action that visually does NOTHING on the device is the cache having
# drifted far enough that insert/deleteElements operate on the dead cache while
# the renderer reads the live model. That is the SDK bug to report.
#
# Usage:
#   ./drift_watch.sh                 # clears logcat, then streams the ledger
#   (full raw log is tee'd to /tmp/ce_drift_raw.log — send THAT to Ratta)
#
# Tap the plugin button on the device; annotate at the user level which action
# number stopped working. Ctrl-C to stop.
set -u

RAW=/tmp/ce_drift_$(date +%Y%m%d_%H%M%S).log

# Clean baseline so each run starts with a low cache count and the drift is
# visible from action #1: reset the note app (rebuilds its per-page trail cache
# from disk) and the pluginhost (loads latest build + resets the #N counter).
echo ">> resetting note app + pluginhost for a clean baseline ..."
adb shell am force-stop com.ratta.supernote.note
adb shell am force-stop com.ratta.supernote.pluginhost
adb logcat -c
: > "$RAW"
echo ">> raw log -> $RAW"
echo ">> NOW: reopen testplugin.note on the device, then tap the plugin button."
echo ">> Ctrl-C when an action visibly does nothing; note its #."
echo
printf '%-26s %-12s %-14s %-12s %-9s\n' ACTION existTrails jniContainers mTrailNumber inserted
printf '%-26s %-12s %-14s %-12s %-9s\n' '------' '----------' '-------------' '------------' '--------'

adb logcat -v time | tee -a "$RAW" | awk '
  function flush() {
    if (hdr != "") {
      printf "%-26s %-12s %-14s %-12s %-9s\n", hdr, et, jc, mt, ic
      fflush()
    }
  }
  /\[CE-PROBE\]/ && /BEGIN/ {
    flush()
    match($0, /#[0-9]+ [A-Z]+/); hdr = substr($0, RSTART, RLENGTH)
    et = "-"; jc = "-"; mt = "-"; ic = "-"
    next
  }
  /exist Trails:/            { s = $0; sub(/.*exist Trails:/, "", s); gsub(/[^0-9-].*/, "", s); et = s }
  /jniTrailContainers size:/ { s = $0; sub(/.*jniTrailContainers size:/, "", s); gsub(/[^0-9-].*/, "", s); jc = s }
  /mTrailNumber [0-9-]/      { match($0, /mTrailNumber [0-9-]+/); mt = substr($0, RSTART + 13, RLENGTH - 13) }
  /insertCount:/             { s = $0; sub(/.*insertCount:/, "", s); gsub(/[^0-9-].*/, "", s); ic = s }
  /\[CE-PROBE\]/ && /END/    { flush(); hdr = "" }
'
