import { NO_TENANT } from '../../gateway/src/db/schema.ts';

export const UNAUTHENTICATED = 'Unauthenticated';
export const DELETED_TENANT = 'Deleted tenant';

/**
 * What to call a tenant on screen. Only a request that never authenticated (no tenant id, or the rollups' sentinel)
 * is "Unauthenticated"; a real tenant id with no name row left is a tenant that was deleted, shown with the start
 * of its id so two deleted tenants are told apart.
 */
export function tenantLabel(tenantId: string | null, name: string | null): string {
  if (tenantId === null || tenantId === NO_TENANT) return UNAUTHENTICATED;
  return name ?? `${DELETED_TENANT} ${tenantId.slice(0, 8)}`;
}
