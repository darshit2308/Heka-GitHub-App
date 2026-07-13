FROM node:20-slim
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci
ENV NODE_ENV="production"
COPY . .
RUN npm run build
RUN npm prune --omit=dev
RUN npm cache clean --force
CMD [ "npm", "start" ]
