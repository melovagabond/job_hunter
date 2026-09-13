FROM node:22-slim
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for linux x64 glibc, so no
# build toolchain is needed here. If you run on an exotic arch and the
# install tries to compile, add: apt-get install -y python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY config ./config
COPY worker ./worker
COPY api ./api

ENV JOB_DB_PATH=/app/data/jobs.sqlite
ENV API_HOST=0.0.0.0
VOLUME /app/data

# Default command is the API; compose overrides for the worker service.
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "api/index.js"]
