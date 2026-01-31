import crypto from "crypto";

const timingSafeEqual = (a: string, b: string) => {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

export const computeSlackSignature = (
  body: string,
  timestamp: string,
  signingSecret: string
) => {
  const base = `v0:${timestamp}:${body}`;
  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(base, "utf8")
    .digest("hex");
  return `v0=${digest}`;
};

export const verifySlackSignature = (
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string
) => {
  if (!timestamp || !signature) return false;
  const fiveMinutes = 60 * 5;
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > fiveMinutes) return false;

  const expected = computeSlackSignature(body, timestamp, signingSecret);
  return timingSafeEqual(expected, signature);
};
