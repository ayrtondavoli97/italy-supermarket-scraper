FROM apify/actor-node-playwright-chrome:20
COPY package.json ./
RUN npm install --omit=dev
COPY . ./
CMD ["node", "src/main.js"]
