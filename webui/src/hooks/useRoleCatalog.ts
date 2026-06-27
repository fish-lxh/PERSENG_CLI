import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getDefaultRoleId, getRoleItems } from '../lib/roles';
import type { RoleListResponse } from '../lib/types';

export function useRoleCatalog() {
  const [roles, setRoles] = useState<RoleListResponse | null>(null);
  const [error, setError] = useState('');

  const reloadRoles = useCallback(async () => {
    try {
      setError('');
      const data = await api.roles();
      setRoles(data);
      return data;
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      throw e;
    }
  }, []);

  useEffect(() => {
    reloadRoles().catch(() => {});
  }, [reloadRoles]);

  return {
    roles,
    roleItems: getRoleItems(roles),
    defaultRoleId: getDefaultRoleId(roles),
    error,
    reloadRoles,
  };
}
