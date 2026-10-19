// Loads app settings from the project's .env file (a minimal dotenv).
const fs = require("fs");
const path = require("path");

function loadConfig() {
  const file = path.join(__dirname, "..", ".env");
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

module.exports = { loadConfig };
