/**
 * Remembers webhook delivery ids for this process only.
 * A second instance does not see them. There is no Redis.
 */
const seenDeliveries = new Map<string, number>();
const DELIVERY_TTL_MS = 10 * 60 * 1000;
const DELIVERY_CAP = 1000;

/** Returns true when this delivery id was already handled inside the last 10 minutes. */
export function alreadyDelivered(deliveryId: string | undefined, now = Date.now()): boolean {
  if (!deliveryId) return false;

  for (const [id, seenAt] of seenDeliveries) {
    if (now - seenAt > DELIVERY_TTL_MS) seenDeliveries.delete(id);
  }
  if (seenDeliveries.has(deliveryId)) return true;

  seenDeliveries.set(deliveryId, now);
  while (seenDeliveries.size > DELIVERY_CAP) {
    const oldest = seenDeliveries.keys().next().value;
    if (oldest === undefined) break;
    seenDeliveries.delete(oldest);
  }
  return false;
}
