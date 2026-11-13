import { diagnostics } from "./diagnostics";

export interface MeteredReservation {
  markWriting(evidence?: Array<{ path: string; after?: string }>): Promise<boolean>;
  commit(): Promise<{ kind: "committed" | "pending" }>;
  rollback(): Promise<void>;
}

export async function runMeteredOperation<T>(
  reserve: () => Promise<MeteredReservation | null>,
  prepare: (reservation: MeteredReservation) => Promise<void>,
  action: () => Promise<T>
): Promise<T> {
  const reservation = await reserve();
  diagnostics.event("usage.reservation", { status: reservation ? "reserved" : "denied" });
  if (!reservation) throw new Error("No Auto Organize run credit is available.");
  let result: T;
  try {
    result = await action();
    await prepare(reservation);
  } catch (error) {
    await reservation.rollback().then(() => diagnostics.event("usage.release", { status: "released" })).catch((failure) => diagnostics.failure("usage.release", failure));
    throw error;
  }
  const settled = await reservation.commit();
  diagnostics.event("usage.settlement", { status: settled.kind });
  if (settled.kind !== "committed") {
    throw new Error("The AI request finished, but account usage confirmation is pending. No file changes were made.");
  }
  return result;
}
