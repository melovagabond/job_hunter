require('dotenv').config();
const path = require('path');
const { writeProfile } = require('./lib/profile');

const output = path.join(__dirname, '..', 'data', 'docs', 'candidate-profile.json');
const profile = writeProfile(output, process.env.RESUME_PATH);
console.log(`[profile] wrote ${profile.skills.length} skills to ${output}`);
