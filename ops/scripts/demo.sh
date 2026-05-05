#!/bin/bash
# 실행: ./ops/scripts/demo.sh start
#       ./ops/scripts/demo.sh restore

COMMAND=$1

if [ "$COMMAND" == "start" ]; then
    echo "[DEMO] Starting attack simulation..."
    node src/simulator/demo.js run

elif [ "$COMMAND" == "restore" ]; then
    echo "[RESTORE] Starting file restoration..."
    node src/simulator/demo.js restore

else
    echo "Usage:"
    echo "  $0 start    # Start attack simulation"
    echo "  $0 restore  # Restore all files"
fi