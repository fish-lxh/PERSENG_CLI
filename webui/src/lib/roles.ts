import { asArray } from './collections';
import type { RoleListResponse } from './types';

export function getRoleItems(data: RoleListResponse | null | undefined) {
  return asArray(data?.roles);
}

export function getDefaultRoleId(data: RoleListResponse | null | undefined) {
  const roles = getRoleItems(data);
  return data?.active || roles[0]?.id || '';
}
