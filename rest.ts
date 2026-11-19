import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorize,
  parseJsonBody,
  pathOf,
  queryOf,
  readBody,
  requestOrigin,
  sendBadRequest,
  sendEmpty,
  sendJson,
  sendNotFound,
  sendUnauthorized,
  type JsonObject,
} from './http.ts';
import { parseTree } from './git/objects.ts';
import type { IssueRecord, Repo, Store } from './store.ts';

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as JsonObject).name === 'string') {
      out.push(String((item as JsonObject).name));
    } else return undefined;
  }
  return out;
}

function repoJson(repo: Repo): JsonObject {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function labelJson(repo: Repo, name: string): JsonObject {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed' };
}

function issueJson(repo: Repo, issue: IssueRecord): JsonObject {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function currentHeadSha(repo: Repo, pull: IssueRecord): string {
  return repo.resolveRef(pull.headRef ?? '') ?? pull.headSha ?? '';
}

function currentBaseSha(repo: Repo, pull: IssueRecord): string {
  return repo.resolveRef(pull.baseRef ?? '') ?? pull.baseSha ?? '';
}

function pullJson(repo: Repo, pull: IssueRecord): JsonObject {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged === true,
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    head: { ref: pull.headRef ?? '', sha: currentHeadSha(repo, pull) },
    base: { ref: pull.baseRef ?? '', sha: currentBaseSha(repo, pull) },
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
  };
}

function decodeContent(value: string): Buffer {
  return Buffer.from(value.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function encodeContent(buf: Buffer): string {
  return buf.toString('base64');
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length) || '/';

  const auth = authorize(req);
  if (!auth.ok) {
    sendUnauthorized(res, auth);
    return true;
  }

  let body: unknown = undefined;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' || (method === 'DELETE' && req.headers['content-length'] && req.headers['content-length'] !== '0')) {
    const raw = await readBody(req);
    // DELETE /contents needs a JSON body; DELETE repo does not.
    if (raw.length > 0) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendBadRequest(res, 'Body should be a JSON object');
        return true;
      }
      body = parsed.value;
    }
  } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendBadRequest(res, 'Body should be a JSON object');
      return true;
    }
    body = parsed.value;
  }

  // The first branch already read the body for POST/PUT/PATCH via the condition? Careful:
  // I mixed logic. Let me handle methods cleanly below if body is still needed...
  // For POST/PUT/PATCH, the first if might not run because of operator precedence!
  // `method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' || (DELETE && content-length)`
  // For POST: first part is true, so it reads body. Good.
  // Then the else if also wouldn't run. Good.
  // Wait, I need to fix POST - first if is: (not GET and not HEAD and not DELETE) OR (DELETE with body)
  // POST: true, reads body. Good.

  const query = queryOf(req);
  const parts = restPath.split('/').filter(Boolean);

  // GET / or GET /api/v3/
  if (parts.length === 0 && method === 'GET') {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    const user = store.viewer;
    sendJson(res, 200, { id: user.id, login: user.login, name: user.name, email: user.email, type: 'User' });
    return true;
  }

  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') {
      const obj = asObject(body);
      const name = asString(obj?.name);
      if (!name) {
        sendJson(res, 400, { message: 'Invalid request.\n\n"name" wasn\'t supplied.' });
        return true;
      }
      const created = store.createRepo({
        name,
        private: asBoolean(obj?.private),
        description: asString(obj?.description),
        defaultBranch: asString(obj?.default_branch),
      });
      if ('error' in created) {
        sendJson(res, 422, { message: `Repository creation failed. A repository named ${name} already exists.` });
        return true;
      }
      sendJson(res, 201, repoJson(created));
      return true;
    }
    if (method === 'GET') {
      const all = store.listViewerRepos();
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const origin = requestOrigin(req);
        const next = new URL(`${origin}/api/v3/user/repos`);
        next.searchParams.set('per_page', String(perPage));
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next.toString()}>; rel="next"`;
      }
      sendJson(res, 200, slice.map(repoJson), headers);
      return true;
    }
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = decodeURIComponent(parts[1]!);
    const name = decodeURIComponent(parts[2]!);
    const repo = store.visibleRepo(owner, name);
    const rest = parts.slice(3);

    if (rest.length === 0) {
      if (!repo) {
        sendNotFound(res);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const obj = asObject(body) ?? {};
        if (typeof obj.description === 'string') repo.description = obj.description;
        if (typeof obj.private === 'boolean') repo.privateFlag = obj.private;
        if (typeof obj.default_branch === 'string') repo.defaultBranch = obj.default_branch;
        if (typeof obj.name === 'string' && obj.name !== repo.name) {
          // ignore rename for now
        }
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        sendEmpty(res, 204);
        return true;
      }
    }

    if (!repo) {
      sendNotFound(res);
      return true;
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const obj = asObject(body) ?? {};
      const ref = asString(obj.ref);
      const sha = asString(obj.sha)?.toLowerCase();
      if (!ref || !sha || !repo.lookup(sha)) {
        sendJson(res, 422, { message: 'Reference does not exist or sha is invalid' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }

    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      sendJson(
        res,
        200,
        repo.branchTips().map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
      );
      return true;
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const sha = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.resolveRef(sha) ?? (repo.lookup(sha.toLowerCase()) ? sha.toLowerCase() : undefined);
      const commits = repo.listCommits(tip);
      sendJson(
        res,
        200,
        commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })),
      );
      return true;
    }

    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'PUT') {
        const obj = asObject(body) ?? {};
        const message = asString(obj.message) ?? 'update';
        const content = asString(obj.content);
        if (content === undefined) {
          sendJson(res, 400, { message: 'content is required' });
          return true;
        }
        const result = store.putContents(repo, {
          path: filePath,
          content: decodeContent(content),
          message,
          branch: asString(obj.branch),
          sha: asString(obj.sha),
        });
        if ('message' in result) {
          sendJson(res, result.status, { message: result.message });
          return true;
        }
        sendJson(res, result.status, {
          content: { sha: result.blob.oid, encoding: 'base64', content: encodeContent(result.blob.data), size: result.blob.data.length },
          commit: { sha: result.commit.oid, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const obj = asObject(body) ?? {};
        const message = asString(obj.message) ?? 'delete';
        const sha = asString(obj.sha);
        if (!sha) {
          sendJson(res, 422, { message: 'sha was not supplied' });
          return true;
        }
        const result = store.deleteContents(repo, { path: filePath, message, branch: asString(obj.branch), sha });
        if ('message' in result) {
          sendJson(res, result.status, { message: result.message });
          return true;
        }
        sendJson(res, 200, { commit: { sha: result.commit.oid, message } });
        return true;
      }
      if (method === 'GET') {
        const refName = query.get('ref') ?? repo.defaultBranch;
        const tip = repo.resolveRef(refName) ?? (repo.lookup(refName.toLowerCase()) ? refName.toLowerCase() : undefined);
        if (!tip) {
          sendNotFound(res);
          return true;
        }
        const treeOid = repo.treeOidAt(tip);
        if (!treeOid) {
          sendNotFound(res);
          return true;
        }
        const dir = repo.listDir(treeOid, filePath);
        const file = repo.fileAt(treeOid, filePath);
        if (file) {
          const object = repo.lookup(file.oid);
          if (object && object.type === 'blob') {
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              content: encodeContent(object.data),
              sha: object.oid,
              size: object.data.length,
              name: filePath.split('/').pop(),
              path: filePath,
            });
            return true;
          }
        }
        // Directory: listDir on a file path returns empty (file isn't a tree). Distinguish missing vs dir.
        if (filePath === '' || filePath === '/') {
          sendJson(res, 200, repo.listDir(treeOid, ''));
          return true;
        }
        // If the path names a tree, listDir from parent? listDir walks into the path and lists children.
        const listed = dir;
        if (listed.length > 0 || isTreePath(repo, treeOid, filePath)) {
          sendJson(res, 200, listed);
          return true;
        }
        sendNotFound(res);
        return true;
      }
    }

    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const obj = asObject(body) ?? {};
      const labelName = asString(obj.name);
      if (!labelName) {
        sendJson(res, 400, { message: 'name is required' });
        return true;
      }
      const label = store.createLabel(repo, labelName, asString(obj.color) ?? 'ededed');
      sendJson(res, 201, { id: label.id, name: label.name, color: label.color });
      return true;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const obj = asObject(body) ?? {};
        const title = asString(obj.title) ?? '';
        const issueBody = asString(obj.body) ?? '';
        const labels = asStringArray(obj.labels);
        const created = store.createIssue(repo, { title, body: issueBody, labels });
        if ('error' in created) {
          sendJson(res, 422, { message: `Label does not exist: ${created.name}` });
          return true;
        }
        sendJson(res, 201, issueJson(repo, created));
        return true;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let items = repo.items.filter((item) => item.kind === 'issue');
        if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
        items = items.slice();
        if (sort === 'created' || sort === 'updated') {
          items.sort((a, b) => a.number - b.number);
        }
        if (direction !== 'asc') items.reverse();
        sendJson(res, 200, items.map((item) => issueJson(repo, item)));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const number = Number(rest[1]);
        const item = repo.items.find((entry) => entry.number === number);
        if (!item) {
          sendNotFound(res);
          return true;
        }
        sendJson(res, 200, item.kind === 'pull' ? pullJson(repo, item) : issueJson(repo, item));
        return true;
      }
      if (rest.length === 2 && method === 'PATCH') {
        const number = Number(rest[1]);
        const item = repo.items.find((entry) => entry.number === number);
        if (!item) {
          sendNotFound(res);
          return true;
        }
        const obj = asObject(body) ?? {};
        if (typeof obj.title === 'string') item.title = obj.title;
        if (typeof obj.body === 'string') item.body = obj.body;
        if (obj.state === 'closed' || obj.state === 'open') {
          item.state = obj.state;
          item.closedAt = obj.state === 'closed' ? new Date().toISOString() : null;
          if (obj.state === 'open') {
            item.merged = false;
            item.mergedAt = null;
          }
        }
        item.updatedAt = new Date().toISOString();
        sendJson(res, 200, issueJson(repo, item));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
        const number = Number(rest[1]);
        const obj = asObject(body) ?? {};
        const commentBody = asString(obj.body) ?? '';
        const comment = store.addComment(repo, number, commentBody);
        if (!comment) {
          sendNotFound(res);
          return true;
        }
        sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: comment.createdAt });
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
        const number = Number(rest[1]);
        if (!repo.items.some((entry) => entry.number === number)) {
          sendNotFound(res);
          return true;
        }
        const comments = repo.comments.get(number) ?? [];
        sendJson(res, 200, comments.map((comment) => ({ id: comment.id, body: comment.body })));
        return true;
      }
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const obj = asObject(body) ?? {};
        const created = store.createPull(repo, {
          title: asString(obj.title) ?? '',
          body: asString(obj.body) ?? '',
          head: asString(obj.head) ?? '',
          base: asString(obj.base) ?? repo.defaultBranch,
        });
        if ('error' in created) {
          sendJson(res, 422, { message: `Validation Failed: ${created.ref} is not a valid ref` });
          return true;
        }
        sendJson(res, 201, pullJson(repo, created));
        return true;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let items = repo.items.filter((item) => item.kind === 'pull');
        if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
        sendJson(res, 200, items.map((item) => pullJson(repo, item)));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const number = Number(rest[1]);
        const item = repo.items.find((entry) => entry.number === number && entry.kind === 'pull');
        if (!item) {
          sendNotFound(res);
          return true;
        }
        sendJson(res, 200, pullJson(repo, item));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const number = Number(rest[1]);
        const item = repo.items.find((entry) => entry.number === number && entry.kind === 'pull');
        if (!item) {
          sendNotFound(res);
          return true;
        }
        const head = currentHeadSha(repo, item);
        const base = item.baseSha ?? currentBaseSha(repo, item);
        const files = store.diffFiles(repo, base, head);
        sendJson(
          res,
          200,
          files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        );
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const number = Number(rest[1]);
        const item = repo.items.find((entry) => entry.number === number && entry.kind === 'pull');
        if (!item) {
          sendNotFound(res);
          return true;
        }
        const result = store.squashMerge(repo, item);
        if (!result.ok) {
          sendJson(res, result.status, { message: result.message });
          return true;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: result.message });
        return true;
      }
    }
  }

  sendNotFound(res);
  return true;
}

function isTreePath(repo: Repo, treeOid: string, dirPath: string): boolean {
  const parts = dirPath.split('/').filter(Boolean);
  let oid = treeOid;
  for (const part of parts) {
    const object = repo.lookup(oid);
    if (!object || object.type !== 'tree') return false;
    const entry = parseTree(object.data).find((e) => e.name === part);
    if (!entry) return false;
    oid = entry.oid;
  }
  const object = repo.lookup(oid);
  return object?.type === 'tree';
}
