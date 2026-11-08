import type {TaskmasterInstallation} from '../../contracts/types.ts';
export type {TaskmasterInstallation} from '../../contracts/types.ts';

export type TaskmasterInstallationClient = {
  observeTaskmasterInstallation(ownerId: string, signal?: AbortSignal): Promise<TaskmasterInstallation>;
};

export function validateTaskmasterInstallation(value: unknown, ownerId: string): TaskmasterInstallation {
  const fail = (): never => {throw Error('taskmaster_installation_unconfirmed');};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'cli_entry_sha256,execution_authorized,license,manifest_sha256,observed_at,owner_id,profile_id,protocol,reason_code,scope,status,version'
    || row.protocol !== 1 || row.owner_id !== ownerId || typeof row.scope !== 'string'
    || !['owner_profile','host_path','profile_and_path'].includes(row.scope) || row.execution_authorized !== false
    || typeof row.profile_id !== 'string' || !/^dsh-profile-[a-f0-9]{48}$/.test(row.profile_id)
    || row.license !== null && (typeof row.license !== 'string' || row.license.length > 128)
    || typeof row.observed_at !== 'string' || row.observed_at.length > 64) return fail();
  const observed = Date.parse(row.observed_at);
  if (!Number.isFinite(observed) || observed > Date.now() + 5000 || Date.now() - observed > 60000) return fail();
  if (row.status === 'available') {
    if (row.scope === 'profile_and_path' || typeof row.version !== 'string' || !/^[0-9][A-Za-z0-9.+-]{0,127}$/.test(row.version)
      || typeof row.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.manifest_sha256)
      || typeof row.cli_entry_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.cli_entry_sha256)
      || row.reason_code !== null) return fail();
  } else if (row.status !== 'missing' || row.scope === 'host_path' || row.version !== null || row.license !== null
    || row.manifest_sha256 !== null || row.cli_entry_sha256 !== null || row.reason_code !== 'package_not_installed') return fail();
  return Object.freeze({...row}) as TaskmasterInstallation;
}
