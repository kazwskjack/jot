const PREFIX = 'slack-artifact:v1:';
export const MAX_SLACK_ARTIFACT_BYTES = 50 * 1024 * 1024;

export interface SlackArtifactRef {
  artifactId: string;
  version: number;
}

export function encodeSlackArtifactRef(artifactId: string, version: number): string {
  if (typeof artifactId !== 'string' || !artifactId || artifactId.length > 512
    || /[\u0000-\u001f\u007f]/.test(artifactId)
    || !Number.isSafeInteger(version) || version < 1) throw new Error('slack_artifact_ref_invalid');
  return `${PREFIX}${Buffer.from(artifactId, 'utf8').toString('base64url')}:${version}`;
}

export function decodeSlackArtifactRef(value: string): SlackArtifactRef | undefined {
  if (typeof value !== 'string' || value.length > 800 || !value.startsWith(PREFIX)) return undefined;
  const match = /^slack-artifact:v1:([A-Za-z0-9_-]{1,700}):([1-9][0-9]{0,8})$/.exec(value);
  if (!match) return undefined;
  let artifactId: string;
  try { artifactId = Buffer.from(match[1]!, 'base64url').toString('utf8'); }
  catch { return undefined; }
  const version = Number(match[2]);
  try {
    if (encodeSlackArtifactRef(artifactId, version) !== value) return undefined;
  } catch { return undefined; }
  return { artifactId, version };
}
