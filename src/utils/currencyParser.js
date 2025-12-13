const SUFFIXES = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

export function parseAmount(input) {
  if (typeof input !== "string") {
    input = String(input);
  }
  
  let cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  
  const suffixMatch = cleaned.match(/([kKmMbB])$/);
  let multiplier = 1;
  
  if (suffixMatch) {
    const suffix = suffixMatch[1].toLowerCase();
    multiplier = SUFFIXES[suffix] || 1;
    cleaned = cleaned.slice(0, -1);
  }
  
  const num = parseFloat(cleaned);
  
  if (isNaN(num)) {
    return null;
  }
  
  const result = num * multiplier;
  return Math.round(result * 100) / 100;
}

export function formatAmount(amount) {
  return `$${parseFloat(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function generateVerificationAmount() {
  const min = 1.00;
  const max = 50.23;
  const amount = Math.random() * (max - min) + min;
  return Math.round(amount * 100) / 100;
}

export function generateLinkCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = Math.floor(Math.random() * 3) + 4;
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function amountsMatch(expected, received, tolerance = 0.01) {
  const exp = parseFloat(expected);
  const rec = parseFloat(received);
  return Math.abs(exp - rec) <= tolerance;
}
