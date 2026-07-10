#!/bin/bash
# Kill anything already running on our ports
kill $(lsof -t -i:3001) 2>/dev/null
kill $(lsof -t -i:5173) 2>/dev/null
sleep 1

# Get local IP
IP=$(ipconfig getifaddr en0)

echo "┌─────────────────────────────────────────┐"
echo "│  Crucible Mobile Launch                 │"
echo "│                                         │"
echo "│  Phone URL:  http://$IP:5173            │"
echo "│  Backend:    http://$IP:3001            │"
echo "│                                         │"
echo "│  Make sure your phone is on the same   │"
echo "│  Wi-Fi network as this Mac.             │"
echo "└─────────────────────────────────────────┘"

# Start backend
npx tsx watch --no-deprecation server.ts &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID"

# Start Vite
npx vite --host 0.0.0.0

# Cleanup on exit
kill $BACKEND_PID 2>/dev/null
