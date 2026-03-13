FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Runtime config: mount your MOHAA files and override as needed.
ENV MOHAA_BASE_PATH=/data/mohaa
ENV PORT=5173

EXPOSE 5173

CMD ["sh", "-c", "npm run dev -- --host 0.0.0.0 --port ${PORT:-5173}"]
