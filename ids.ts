/** Opaque GraphQL global ids. Never equal to String(databaseId) or String(number). */

export type NodeType = 'Repository' | 'Issue' | 'PullRequest' | 'User' | 'IssueComment';

const PREFIX = 'gid:github-core:';

export function toGlobalId(type: NodeType, databaseId: number): string {
  return Buffer.from(`${PREFIX}${type}:${databaseId}`, 'utf8').toString('base64');
}

export function fromGlobalId(id: string): { type: NodeType; databaseId: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(PREFIX)) return null;
  const rest = decoded.slice(PREFIX.length);
  const colon = rest.lastIndexOf(':');
  if (colon < 0) return null;
  const type = rest.slice(0, colon) as NodeType;
  const databaseId = Number(rest.slice(colon + 1));
  if (!Number.isInteger(databaseId) || databaseId <= 0) return null;
  if (!['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].includes(type)) return null;
  return { type, databaseId };
}
