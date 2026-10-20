import {
  isValidDetachedThread,
  newDetachedThreadId,
} from "@/graph/detached-thread";

// Playground thread key: tenantId:playground:agentId:uuid (see graph/detached-thread.ts).

export function newPlaygroundThreadId(
  tenantId: bigint,
  agentId: bigint,
): string {
  return newDetachedThreadId("playground", tenantId, agentId);
}

export function isValidPlaygroundThread(
  threadId: string,
  tenantId: bigint,
  agentId: bigint,
): boolean {
  return isValidDetachedThread("playground", threadId, tenantId, agentId);
}
