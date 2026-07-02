# Field-test app image: plain Node server + AWS Lambda Web Adapter, so the
# same container runs locally (`docker run -p 8080:8080`) and on Lambda.
FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS adapter

FROM node:22-slim
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app
COPY package.json package-lock.json ./
# Full install (not --omit=dev): tsx is the runtime here. sharp resolves its
# linux binaries during this install — never copy a host node_modules in.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "src/app/server.ts"]
