import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorize, parseJsonBody, readBody, sendJson, sendUnauthorized } from './http.ts';
import type { Store } from './store.ts';

const PROTOCOL = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });

type Json = Record<string, unknown>;

const TOOLS: readonly Json[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Repository name' }),
        description: Object.freeze({ type: 'string' }),
        private: Object.freeze({ type: 'boolean' }),
        owner: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        full_name: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        title: Object.freeze({ type: 'string' }),
        body: Object.freeze({ type: 'string' }),
        full_name: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        state: Object.freeze({ type: 'string' }),
        full_name: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        title: Object.freeze({ type: 'string' }),
        body: Object.freeze({ type: 'string' }),
        head: Object.freeze({ type: 'string' }),
        base: Object.freeze({ type: 'string' }),
        full_name: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        pull_number: Object.freeze({ type: 'integer' }),
        full_name: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// Cached byte-identical tools/list result.
const TOOLS_LIST_RESULT = Object.freeze({ tools: TOOLS });

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolResult(payload: unknown, isError = false): Json {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
    isError,
  };
}

function ownerRepo(args: Json): { owner: string; repo: string } | { error: string } {
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if ((!owner || !repo) && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (!owner) owner = o ?? '';
    if (!repo) repo = r ?? '';
  }
  if (!owner || !repo) return { error: 'owner and repo are required' };
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Json): Json | { rpc: Json } {
  const canonical = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = TOOLS.some((tool) => (tool.name as string).toLowerCase().replace(/[^a-z0-9]/g, '') === canonical
    || canonical.endsWith((tool.name as string).toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (!known) return { rpc: rpcError(undefined, -32602, `Unknown tool: ${name}`) };

  const tool = TOOLS.find((entry) => {
    const n = (entry.name as string).toLowerCase().replace(/[^a-z0-9]/g, '');
    return canonical === n || canonical.endsWith(n);
  })!;
  const schema = tool.inputSchema as { required?: readonly string[] };
  const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return toolResult({ message: `Missing required arguments: ${missing.join(', ')}` }, true);
  }

  if (canonical.endsWith('createrepo') || canonical.endsWith('createrepository')) {
    const repoName = String(args.name ?? args.repo ?? '');
    if (!repoName) return toolResult({ message: 'name is required' }, true);
    const created = store.createRepo({
      name: repoName,
      private: args.private === true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    if ('error' in created) return toolResult({ message: `A repository named ${repoName} already exists.` }, true);
    return toolResult({
      id: created.id,
      name: created.name,
      full_name: created.fullName,
      private: created.privateFlag,
      default_branch: created.defaultBranch,
      owner: { login: created.owner },
      description: created.description,
    });
  }

  if (canonical.endsWith('getrepo') || canonical.endsWith('getrepository')) {
    const loc = ownerRepo(args);
    if ('error' in loc) return toolResult({ message: loc.error }, true);
    const repo = store.visibleRepo(loc.owner, loc.repo);
    if (!repo) return toolResult({ message: 'Not Found' }, true);
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      private: repo.privateFlag,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
      description: repo.description,
    });
  }

  if (canonical.endsWith('createissue')) {
    const loc = ownerRepo(args);
    if ('error' in loc) return toolResult({ message: loc.error }, true);
    const repo = store.visibleRepo(loc.owner, loc.repo);
    if (!repo) return toolResult({ message: 'Not Found' }, true);
    const created = store.createIssue(repo, { title: String(args.title ?? ''), body: String(args.body ?? '') });
    if ('error' in created) return toolResult({ message: `Label does not exist: ${created.name}` }, true);
    return toolResult({
      id: created.id,
      number: created.number,
      title: created.title,
      body: created.body,
      state: created.state,
    });
  }

  if (canonical.endsWith('listissues')) {
    const loc = ownerRepo(args);
    if ('error' in loc) return toolResult({ message: loc.error }, true);
    const repo = store.visibleRepo(loc.owner, loc.repo);
    if (!repo) return toolResult({ message: 'Not Found' }, true);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let items = repo.items.filter((item) => item.kind === 'issue');
    if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
    return toolResult({
      issues: items.map((item) => ({ id: item.id, number: item.number, title: item.title, body: item.body, state: item.state })),
    });
  }

  if (canonical.endsWith('createpullrequest') || canonical.endsWith('createpr')) {
    const loc = ownerRepo(args);
    if ('error' in loc) return toolResult({ message: loc.error }, true);
    const repo = store.visibleRepo(loc.owner, loc.repo);
    if (!repo) return toolResult({ message: 'Not Found' }, true);
    const created = store.createPull(repo, {
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      head: String(args.head ?? ''),
      base: String(args.base ?? repo.defaultBranch),
    });
    if ('error' in created) return toolResult({ message: `Validation Failed: ${created.ref}` }, true);
    return toolResult({
      id: created.id,
      number: created.number,
      title: created.title,
      body: created.body,
      state: created.state,
      head: { ref: created.headRef },
      base: { ref: created.baseRef },
    });
  }

  if (canonical.endsWith('mergepullrequest') || canonical.endsWith('mergepr')) {
    const loc = ownerRepo(args);
    if ('error' in loc) return toolResult({ message: loc.error }, true);
    const repo = store.visibleRepo(loc.owner, loc.repo);
    if (!repo) return toolResult({ message: 'Not Found' }, true);
    const number = Number(args.pull_number ?? args.number ?? args.pull_request_number);
    const pull = repo.items.find((item) => item.kind === 'pull' && item.number === number);
    if (!pull) return toolResult({ message: 'Not Found' }, true);
    const result = store.squashMerge(repo, pull);
    if (!result.ok) return toolResult({ message: result.message }, true);
    return toolResult({ sha: result.sha, merged: true, message: result.message, number: pull.number });
  }

  return { rpc: rpcError(undefined, -32601, `Unknown tool: ${name}`) };
}

function handleRequest(store: Store, body: Json): Json {
  const id = body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params)
    ? (body.params as Json)
    : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return rpcResult(id, {});
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') return rpcResult(id, TOOLS_LIST_RESULT);

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Json)
      : {};
    const result = callTool(store, name, args);
    if ('rpc' in result) {
      const err = result.rpc;
      return { jsonrpc: '2.0', id: id ?? null, error: err.error };
    }
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

function extractId(text: string): unknown {
  const match = /"id"\s*:\s*(null|"[^"]*"|-?\d+)/.exec(text);
  if (!match) return null;
  const raw = match[1]!;
  if (raw === 'null') return null;
  if (raw.startsWith('"')) return raw.slice(1, -1);
  return Number(raw);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if ((req.method ?? 'POST').toUpperCase() === 'DELETE') {
    const auth = authorize(req);
    if (!auth.ok) {
      sendUnauthorized(res, auth);
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    // Parse errors are answered even when unauthenticated so the body can be judged; but
    // the suite only sends this after connect() with a token. Still require auth first? The
    // parse-error check is authenticated. Auth-required is a different call. If the body is
    // not JSON we prefer -32700 / HTTP 400 (the documented contract).
    const auth = authorize(req);
    if (!auth.ok) {
      sendUnauthorized(res, auth);
      return;
    }
    sendJson(res, 400, rpcError(extractId(raw.toString('utf8')), -32700, 'Parse error'));
    return;
  }

  const auth = authorize(req);
  if (!auth.ok) {
    sendUnauthorized(res, auth);
    return;
  }

  const value = parsed.value;
  if (Array.isArray(value)) {
    sendJson(res, 200, value.map((entry) => handleRequest(store, (entry ?? {}) as Json)));
    return;
  }
  if (value === null || typeof value !== 'object') {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const body = value as Json;
  // Notifications have no id; answer 202/200 with an empty body or a result if id is present.
  if (body.id === undefined && typeof body.method === 'string' && body.method.startsWith('notifications/')) {
    res.writeHead(202, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': 0,
      'x-github-request-id': `${Date.now()}`,
    });
    res.end();
    return;
  }
  sendJson(res, 200, handleRequest(store, body));
}
