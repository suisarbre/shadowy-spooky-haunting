#!/bin/sh
# A payload script: reports on the flight computer every 2 s until stopped, and answers what you type.
echo "sysreport running on $(hostname), Linux $(uname -r), from $(pwd)"
echo "type a line and it comes back; 'ls' lists the SD card's data partition"
( while true; do
    echo "uptime $(cut -d' ' -f1 /proc/uptime) s · load $(cut -d' ' -f1 /proc/loadavg) · RAM available $(grep MemAvailable /proc/meminfo | tr -s ' ' | cut -d' ' -f2) kB · /sd $(du -sk /sd | cut -f1) kB used"
    sleep 2
  done ) &
while read -r line; do
  case "$line" in
    ls) ls -l /sd ;;
    *) echo "satellite heard: $line" ;;
  esac
done
