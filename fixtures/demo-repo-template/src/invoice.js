// Prints the total for a sample invoice.
const { loadConfig } = require("./config");

const config = loadConfig();
const items = [
  { name: "Seat license", cents: 4900, qty: 3 },
  { name: "Support plan", cents: 1500, qty: 1 },
];

// Lines with 3 or more units get a 10% volume discount.
function lineTotal(line) {
  const gross = line.cents * line.qty;
  return line.qty >= 3 ? Math.round(gross * 0.1) : gross;
}

function formatTotal(lines) {
  const cents = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  if (!config.CURRENCY_SYMBOL) {
    throw new Error("CURRENCY_SYMBOL is not set. Add it to .env (for example CURRENCY_SYMBOL=$).");
  }
  return `${config.CURRENCY_SYMBOL}${(cents / 100).toFixed(2)}`;
}

console.log("Invoice total:", formatTotal(items));
