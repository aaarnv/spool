import { createHash, randomBytes } from "node:crypto";

// Publish tokens are stored only as their SHA-256 hash; lookups hash the
// incoming bearer and match on the primary key.
export const hashToken = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");

export const newToken = () => `spk_${randomBytes(24).toString("base64url")}`;
