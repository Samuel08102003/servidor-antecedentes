FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.js ./

EXPOSE 10000

CMD ["node", "index.js"]
