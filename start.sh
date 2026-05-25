 rm -f /tmp/.X99-lock
  echo "Iniciando Xvfb..."
  Xvfb :99 -screen 0 1280x800x24 -ac &
  export DISPLAY=:99
  sleep 2
  echo "Iniciando servidor Node.js..."
  exec node index.js

  Dockerfile — cambia la última línea para usar el script:
  FROM mcr.microsoft.com/playwright:v1.60.0-jammy

  WORKDIR /app

  COPY package.json ./
  RUN npm install

  COPY index.js ./
  COPY start.sh ./
  RUN chmod +x start.sh

  RUN npx playwright install chromium --with-deps

  EXPOSE 10000

  CMD ["./start.sh"]
