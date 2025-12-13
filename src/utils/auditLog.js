import { db } from "../db/index.js";
import { auditLogs } from "../db/schema.js";

export async function logAction(tradeId, actorId, action, rawPayload = null, actorType = "user") {
  try {
    await db.insert(auditLogs).values({
      tradeId,
      actorId,
      actorType,
      action,
      rawPayload,
    });
  } catch (error) {
    console.error("Failed to log audit action:", error);
  }
}
