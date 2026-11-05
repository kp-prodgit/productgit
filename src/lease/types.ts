export interface LeaseInfo {
  taskId: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  /** Git-ref lease: the claim commit. Cloud lease: the fencing token. */
  token: string;
}

export type Acquire = { ok: true; lease: LeaseInfo } | { ok: false; holder: string; expiresAt: string };

/**
 * An atomic claim (PULL-6): exactly one agent wins a task.
 * v1 is a git ref; the paid tier swaps in a DynamoDB lease with fencing tokens (ee/).
 */
export interface LeaseProvider {
  readonly kind: "git" | "cloud";
  acquire(taskId: string, holder: string, ttlSeconds: number): Promise<Acquire>;
  release(taskId: string, holder: string): Promise<boolean>;
  /** Releases someone else's lease. Only for stale leases (PULL-7). */
  forceRelease(taskId: string, expectedToken: string): Promise<boolean>;
  list(): Promise<LeaseInfo[]>;
}

/** Time-to-live: twice the size's expected runtime (PULL-7). */
export function leaseTtlSeconds(minutes: number): number {
  return Math.round(minutes * 2 * 60);
}
