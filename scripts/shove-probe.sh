#!/bin/bash
# Live production probe: shove all-in every hand until the bot calls,
# so the all-in runout reveal fires and can be screenshotted.
set -u
cd /home/z/my-project
mkdir -p /tmp/render

for round in $(seq 1 "${1:-14}"); do
  SNAP=$(agent-browser snapshot -i -c 2>/dev/null)
  if echo "$SNAP" | grep -q '"All-in"'; then
    # our turn with aggression available: click All-in preset, confirm with R
    agent-browser find text "All-in" click >/dev/null 2>&1
    sleep 0.35
    agent-browser press r >/dev/null 2>&1
    echo "round $round: SHOVED"
    sleep 1.9            # bot reacts (~) + flop deals at 900ms
    agent-browser screenshot "/tmp/render/runout-$round-a.png" >/dev/null 2>&1
    sleep 1.4
    agent-browser screenshot "/tmp/render/runout-$round-b.png" >/dev/null 2>&1
  elif echo "$SNAP" | grep -q '"Call '; then
    agent-browser press c >/dev/null 2>&1   # check or call whatever is owed
    echo "round $round: call/check"
    sleep 1.6
    agent-browser screenshot "/tmp/render/runout-$round-a.png" >/dev/null 2>&1
  else
    echo "round $round: idle (hand running)"
    sleep 1.6
    agent-browser screenshot "/tmp/render/runout-$round-a.png" >/dev/null 2>&1
  fi
done
echo "PROBE DONE"
