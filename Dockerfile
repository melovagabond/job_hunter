FROM node:22-slim
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for linux x64 glibc, so no
# build toolchain is needed here. If you run on an exotic arch and the
# install tries to compile, add: apt-get install -y python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY config ./config
COPY worker ./worker
COPY api ./api

ENV JOB_DB_PATH=/app/data/jobs.sqlite
VOLUME /app/data

# Default command is the API; compose overrides for the worker service.
EXPOSE 3001
CMD ["node", "api/index.js"]
