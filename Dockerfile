FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --legacy-peer-deps
RUN npm install -g @anthropic-ai/claude-code
CMD ["node", "Bridge.js"]
