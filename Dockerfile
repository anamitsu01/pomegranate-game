FROM node:22-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
