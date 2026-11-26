FROM node:24-slim
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 ALLOW_CONTAINER_BIND=1 PORT=3000
EXPOSE 3000
CMD ["node", "packages/harness/src/http.ts"]
