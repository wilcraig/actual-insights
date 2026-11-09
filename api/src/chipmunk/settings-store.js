const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Same data dir as the other Insights settings. Nothing secret lives here.
const DATA_DIR = process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';
const FILE_NAME = 'chipmunk-mode.json';

function defaultSettings() {
  return { enabled: false };
}

// Missing file -> off. A corrupt-but-present file propagates its parse error
// rather than silently resetting.
async function readSettings(dataDir = DATA_DIR) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir, FILE_NAME), 'utf8'));
    return { enabled: parsed && parsed.enabled === true };
  } catch (err) {
    if (err.code === 'ENOENT') return defaultSettings();
    throw err;
  }
}

async function writeSettings(settings, dataDir = DATA_DIR) {
  const finalPath = path.join(dataDir, FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ enabled: settings.enabled === true }));
  await fs.rename(tmpPath, finalPath);
}

module.exports = { readSettings, writeSettings, defaultSettings };
