import crypto from "crypto";

export function generateHmac(payload, secret) {
  // Accept either a raw string payload or an object
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function verifyHmac(payload, signature, secret) {
  if (!signature || !secret) return false
  const expected = generateHmac(payload, secret);

  try {
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)
    if (sigBuf.length !== expBuf.length) return false
    return crypto.timingSafeEqual(expBuf, sigBuf);
  } catch (err) {
    return false
  }
}
