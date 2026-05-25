#!/bin/bash
echo "Iniciando Xvfb (pantalla virtual)..."
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99
echo "DISPLAY=$DISPLAY"
sleep 2
echo "Iniciando servidor Node.js..."
exec node index.js
