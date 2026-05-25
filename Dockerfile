 FROM mcr.microsoft.com/playwright:v1.60.0-focal

  WORKDIR /app

  COPY package.json ./
  RUN npm install

  COPY index.js ./

  RUN npx playwright install chromium --with-deps

  EXPOSE 10000

  CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 -ac & export DISPLAY=:99 && node index.js"]
