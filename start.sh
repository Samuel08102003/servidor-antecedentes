#!/bin/bash
rm -f /tmp/.X99-lock
echo "Iniciando Xvfb..."
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99
sleep 2
echo "Iniciando servidor Node.js..."
exec node index.js
