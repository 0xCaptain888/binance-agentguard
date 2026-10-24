FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force
COPY src ./src
COPY contracts ./contracts
COPY site/bsc ./site/bsc
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=43188 BSC_LISTEN_HOST=0.0.0.0 BSC_JOURNAL_PATH=/data/journal.json
EXPOSE 43188
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:43188/healthz',{headers:{host:new URL(process.env.BSC_PUBLIC_ORIGIN).host}});if(!r.ok)process.exit(1)"
CMD ["node", "--import", "tsx", "src/bsc/server.ts", "--testnet"]
