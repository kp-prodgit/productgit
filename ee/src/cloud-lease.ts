// Product Git Commercial License. See ee/LICENSE.
import type { Acquire, LeaseInfo, LeaseProvider } from "../../src/lease/types.js";
import { CloudError, type Cloud } from "../../src/cloud/client.js";

interface Lease {
  taskId: string;
  holder: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

const info = (l: Lease): LeaseInfo => ({ taskId: l.taskId, holder: l.holder, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt, token: String(l.fencingToken) });

/**
 * The paid-tier lease (PULL-6 later form): DynamoDB conditional writes with fencing tokens,
 * through the control plane. Chosen when team config sets `"lease": "cloud"`.
 */
export function cloudLease(cloud: Cloud, orgId: string): LeaseProvider {
  const path = (taskId: string) => `/orgs/${orgId}/leases/${encodeURIComponent(taskId)}`;
  return {
    kind: "cloud",
    async acquire(taskId, holder, ttlSeconds): Promise<Acquire> {
      try {
        const l = await cloud.call<Lease>("POST", path(taskId), { holder, ttlSeconds });
        return { ok: true, lease: info(l) };
      } catch (e) {
        if (e instanceof CloudError && e.status === 409) return { ok: false, holder: e.body?.holder ?? "unknown", expiresAt: e.body?.expiresAt ?? "" };
        throw e;
      }
    },
    async release(taskId, holder) {
      const current = (await this.list()).find((l) => l.taskId === taskId);
      if (!current) return true;
      if (current.holder !== holder) return false;
      return this.forceRelease(taskId, current.token);
    },
    async forceRelease(taskId, expectedToken) {
      const current = (await this.list()).find((l) => l.taskId === taskId);
      if (!current) return true;
      if (current.token !== expectedToken) return false;
      try {
        await cloud.call("DELETE", path(taskId), { holder: current.holder, fencingToken: Number(expectedToken) });
        return true;
      } catch (e) {
        if (e instanceof CloudError && e.status === 409) return false;
        throw e;
      }
    },
    async list() {
      const { leases } = await cloud.call<{ leases: Lease[] }>("GET", `/orgs/${orgId}/leases`);
      return leases.map(info);
    },
  };
}
