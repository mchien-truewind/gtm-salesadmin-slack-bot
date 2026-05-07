FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/slack ./scripts/slack

EXPOSE 3000

CMD ["npm", "run", "start"]
