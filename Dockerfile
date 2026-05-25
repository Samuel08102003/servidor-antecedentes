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
