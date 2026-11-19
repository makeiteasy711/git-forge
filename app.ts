// HTTP surface: health probe, REST v3, git smart HTTP, GraphQL v4 and MCP.
// main.ts owns listen(); createApp() only builds the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git/smart.ts';
import { handleGraphQL } from './graphql.ts';
import { pathOf, sendJson, sendNotFound, authorize, sendUnauthorized } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/graphql' || path.startsWith('/api/graphql')) {
      await handleGraphQL(req, res, store);
      return;
    }

    if (path === '/mcp' || path.startsWith('/mcp')) {
      await handleMcp(req, res, store);
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      await handleRest(req, res, store);
      return;
    }

    if (await handleGit(req, res, store)) return;

    if (path.startsWith('/api/')) {
      const auth = authorize(req);
      if (!auth.ok) {
        sendUnauthorized(res, auth);
        return;
      }
    }
    sendNotFound(res);
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  }
}
