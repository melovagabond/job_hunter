require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db/db');

async function main() {
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(dir, `jobs-${stamp}.sqlite`);
  await db.connect().backup(destination);
  db.close();
  console.log(`[backup] wrote ${destination}`);
}

main().catch(err => { console.error(err); process.exit(1); });
