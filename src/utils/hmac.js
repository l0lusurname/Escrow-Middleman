import crypto from "crypto";

export function generateHmac(payload, secret) {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

export function verifyHmac(payload, signature, secret) {
  const expected = generateHmac(payload, secret);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
