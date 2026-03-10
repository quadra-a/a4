FROM node:22-alpine

WORKDIR /app

RUN npm install -g pnpm

COPY package.docker.json ./package.json
COPY dist ./dist

RUN pnpm install --prod --no-frozen-lockfile

EXPOSE 8080
EXPOSE 8081

VOLUME /data

ENV PORT=8080
ENV LANDING_PORT=8081
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
