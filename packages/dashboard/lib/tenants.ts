import { NO_TENANT } from '../../gateway/src/db/schema.ts';

export const UNAUTHENTICATED = 'Unauthenticated (no key)';
export const DELETED_TENANT = 'Deleted tenant';

export type TenantKind = 'tenant' | 'unauthenticated' | 'deleted';

/**
 * What to call a tenant on screen, and which kind of row it is. Only a request that never authenticated (no tenant id, or
 * the rollups' sentinel) is `unauthenticated`; a real tenant id with no name row left is `deleted`, shown with the start of
 * its id so two deleted tenants are told apart. The two sentinel kinds carry a suffix a tenant's own name does not, and
 * the views style them apart (muted), so a tenant that happens to be named "Unauthenticated" is not mistaken for them.
 */
export function tenantLabel(tenantId: string | null, name: string | null): { label: string; kind: TenantKind } {
  if (tenantId === null || tenantId === NO_TENANT) return { label: UNAUTHENTICATED, kind: 'unauthenticated' };
  if (name === null) return { label: `${DELETED_TENANT} ${tenantId.slice(0, 8)} (removed)`, kind: 'deleted' };
  return { label: name, kind: 'tenant' };
}
