import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromGlobalId, toGlobalId, type NodeType } from './ids.ts';
import {
  authorize,
  parseJsonBody,
  readBody,
  sendBadRequest,
  sendJson,
  sendUnauthorized,
} from './http.ts';
import type { IssueRecord, Repo, Store } from './store.ts';

// -------------------------------------------------------------------------------------------------
// A small GraphQL parser: operations, fields, aliases, arguments, variables, inline fragments.
// -------------------------------------------------------------------------------------------------

export type GqlValue =
  | null
  | boolean
  | number
  | string
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'var'; readonly name: string }
  | readonly GqlValue[]
  | { readonly [key: string]: GqlValue };

export interface GqlField {
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | { kind: 'inline'; typeName: string; selections: GqlSelection[] };

export interface GqlOperation {
  operation: 'query' | 'mutation';
  name: string | null;
  variableNames: string[];
  selections: GqlSelection[];
}

class Parser {
  private i = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  parseDocument(): GqlOperation {
    this.skip();
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const variableNames: string[] = [];
    if (this.matchName('query') || this.matchName('mutation')) {
      operation = this.src.slice(this.markNameStart(), this.i).endsWith('n') || this.lookBehind('mutation')
        ? (this.previousWas('mutation') ? 'mutation' : 'query')
        : 'query';
    }
    // The above is messy because matchName already consumed. Re-parse from start of keyword-less shorthand.
    return this.parseOperation();
  }

  private previousWas(_word: string): boolean {
    return true;
  }

  private markNameStart(): number {
    return this.i;
  }

  private lookBehind(_word: string): boolean {
    return false;
  }

  parseOperation(): GqlOperation {
    this.i = 0;
    this.skip();
    let operation: 'query' | 'mutation' = 'query';
    if (this.peekName() === 'query' || this.peekName() === 'mutation') {
      operation = this.name() as 'query' | 'mutation';
      this.skip();
    }
    let name: string | null = null;
    if (this.isIdentStart()) {
      name = this.name();
      this.skip();
    }
    const variableNames: string[] = [];
    if (this.eat('(')) {
      this.skip();
      while (!this.eat(')')) {
        this.expect('$');
        variableNames.push(this.name());
        this.skip();
        this.expect(':');
        this.skip();
        this.skipType();
        this.skip();
        if (this.eat(',')) this.skip();
      }
      this.skip();
    }
    this.expect('{');
    const selections = this.parseSelections();
    return { operation, name, variableNames, selections };
  }

  private skipType(): void {
    if (this.eat('[')) {
      this.skip();
      this.skipType();
      this.skip();
      this.expect(']');
      this.skip();
      this.eat('!');
      return;
    }
    this.name();
    this.skip();
    this.eat('!');
  }

  private parseSelections(): GqlSelection[] {
    const out: GqlSelection[] = [];
    this.skip();
    while (!this.eat('}')) {
      if (this.eat('...')) {
        this.skip();
        if (this.peekName() === 'on') {
          this.name();
          this.skip();
          const typeName = this.name();
          this.skip();
          this.expect('{');
          out.push({ kind: 'inline', typeName, selections: this.parseSelections() });
        } else {
          throw new Error('named fragment spreads are not supported');
        }
      } else {
        out.push(this.parseField());
      }
      this.skip();
      this.eat(',');
      this.skip();
    }
    return out;
  }

  private parseField(): GqlField {
    let aliasOrName = this.name();
    this.skip();
    let name = aliasOrName;
    let alias = aliasOrName;
    if (this.eat(':')) {
      this.skip();
      name = this.name();
      this.skip();
    }
    const args: Record<string, GqlValue> = {};
    if (this.eat('(')) {
      this.skip();
      while (!this.eat(')')) {
        const argName = this.name();
        this.skip();
        this.expect(':');
        this.skip();
        args[argName] = this.parseValue();
        this.skip();
        this.eat(',');
        this.skip();
      }
      this.skip();
    }
    let selections: GqlSelection[] = [];
    if (this.eat('{')) selections = this.parseSelections();
    return { alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    this.skip();
    if (this.eat('$')) return { kind: 'var', name: this.name() };
    if (this.eat('[')) {
      const items: GqlValue[] = [];
      this.skip();
      while (!this.eat(']')) {
        items.push(this.parseValue());
        this.skip();
        this.eat(',');
        this.skip();
      }
      return items;
    }
    if (this.eat('{')) {
      const obj: Record<string, GqlValue> = {};
      this.skip();
      while (!this.eat('}')) {
        const key = this.name();
        this.skip();
        this.expect(':');
        this.skip();
        obj[key] = this.parseValue();
        this.skip();
        this.eat(',');
        this.skip();
      }
      return obj;
    }
    if (this.peek() === '"' || this.peek() === "'") return this.parseString();
    if (this.peek() === '-' || (this.peek() >= '0' && this.peek() <= '9')) return this.parseNumber();
    const ident = this.name();
    if (ident === 'true') return true;
    if (ident === 'false') return false;
    if (ident === 'null') return null;
    return { kind: 'enum', value: ident };
  }

  private parseString(): string {
    const quote = this.peek();
    this.i += 1;
    let out = '';
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === quote) {
        this.i += 1;
        return out;
      }
      if (ch === '\\') {
        this.i += 1;
        const esc = this.src[this.i] ?? '';
        const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\', '/': '/' };
        if (esc === 'u') {
          const hex = this.src.slice(this.i + 1, this.i + 5);
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 5;
        } else {
          out += map[esc] ?? esc;
          this.i += 1;
        }
        continue;
      }
      out += ch;
      this.i += 1;
    }
    throw new Error('unterminated string');
  }

  private parseNumber(): number {
    const start = this.i;
    if (this.eat('-')) {
      /* sign */
    }
    while (this.peek() >= '0' && this.peek() <= '9') this.i += 1;
    if (this.eat('.')) {
      while (this.peek() >= '0' && this.peek() <= '9') this.i += 1;
    }
    return Number(this.src.slice(start, this.i));
  }

  private peek(): string {
    return this.src[this.i] ?? '';
  }

  private peekName(): string | null {
    const saved = this.i;
    this.skip();
    if (!this.isIdentStart()) {
      this.i = saved;
      return null;
    }
    const n = this.name();
    this.i = saved;
    return n;
  }

  private matchName(word: string): boolean {
    const saved = this.i;
    this.skip();
    if (this.peekName() === word) {
      this.i = saved;
      this.skip();
      this.name();
      return true;
    }
    this.i = saved;
    return false;
  }

  private isIdentStart(): boolean {
    const ch = this.peek();
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
  }

  private name(): string {
    if (!this.isIdentStart()) throw new Error(`expected name at ${this.i}, got ${JSON.stringify(this.peek())}`);
    const start = this.i;
    this.i += 1;
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_') this.i += 1;
      else break;
    }
    return this.src.slice(start, this.i);
  }

  private eat(ch: string): boolean {
    if (this.src.startsWith(ch, this.i)) {
      this.i += ch.length;
      return true;
    }
    return false;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) throw new Error(`expected ${JSON.stringify(ch)} at ${this.i}`);
  }

  private skip(): void {
    for (;;) {
      while (this.i < this.src.length && /[\s,]/.test(this.src[this.i]!)) this.i += 1;
      if (this.src[this.i] === '#') {
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i += 1;
        continue;
      }
      break;
    }
  }
}

export function parseGraphQL(source: string): GqlOperation {
  return new Parser(source).parseOperation();
}

function isVar(value: GqlValue): value is { kind: 'var'; name: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { kind?: string }).kind === 'var';
}

function isEnum(value: GqlValue): value is { kind: 'enum'; value: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { kind?: string }).kind === 'enum';
}

function coerce(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (isVar(value)) return variables[value.name];
  if (isEnum(value)) return value.value;
  if (Array.isArray(value)) return value.map((item) => coerce(item, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = coerce(item as GqlValue, variables);
    return out;
  }
  return value;
}

// -------------------------------------------------------------------------------------------------
// Schema introspection
// -------------------------------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels', 'url', 'resourcePath'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName',
  'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'mergeCommit',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
  'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

function typeFields(name: string): { kind: string; fields?: { name: string }[]; enumValues?: { name: string }[] } | null {
  if (name === 'Issue') return { kind: 'OBJECT', fields: ISSUE_FIELDS.map((n) => ({ name: n })) };
  if (name === 'PullRequest') return { kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })) };
  if (name === 'Repository') return { kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((n) => ({ name: n })) };
  if (name === 'SearchType') return { kind: 'ENUM', enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) };
  if (name === 'User') return { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'databaseId'].map((n) => ({ name: n })) };
  return null;
}

// -------------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
}

interface ExecContext {
  store: Store;
  errors: GqlError[];
  variables: Record<string, unknown>;
}

function issueState(issue: IssueRecord): 'OPEN' | 'CLOSED' {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: IssueRecord): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function findRepoById(store: Store, databaseId: number): Repo | undefined {
  return [...store.repos.values()].find((repo) => repo.id === databaseId);
}

function findItemById(store: Store, databaseId: number, kind?: 'issue' | 'pull'): { repo: Repo; item: IssueRecord } | undefined {
  for (const repo of store.repos.values()) {
    const item = repo.items.find((entry) => entry.id === databaseId && (kind === undefined || entry.kind === kind));
    if (item) return { repo, item };
  }
  return undefined;
}

function findCommentById(store: Store, databaseId: number): { repo: Repo; comment: { id: number; body: string } } | undefined {
  for (const repo of store.repos.values()) {
    for (const list of repo.comments.values()) {
      const comment = list.find((entry) => entry.id === databaseId);
      if (comment) return { repo, comment };
    }
  }
  return undefined;
}

function visibleRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.visibleRepo(owner, name);
}

function select(ctx: ExecContext, typeName: string, source: unknown, selections: readonly GqlSelection[]): unknown {
  if (source === null || source === undefined) return source;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if ('kind' in sel && sel.kind === 'inline') {
      if (sel.typeName === typeName) Object.assign(out, select(ctx, typeName, source, sel.selections) as object);
      continue;
    }
    const field = sel as GqlField;
    out[field.alias] = resolveField(ctx, typeName, source, field);
  }
  return out;
}

function arg(ctx: ExecContext, field: GqlField, name: string): unknown {
  if (!(name in field.args)) return undefined;
  return coerce(field.args[name]!, ctx.variables);
}

function resolveField(ctx: ExecContext, typeName: string, source: unknown, field: GqlField): unknown {
  const known = resolver(ctx, typeName, source, field);
  if (known === UNRESOLVED) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const value = known;
  if (value !== null && value !== undefined && field.selections.length > 0) {
    if (Array.isArray(value)) {
      const itemType = listItemType(typeName, field.name);
      return value.map((item) => select(ctx, itemType, item, field.selections));
    }
    return select(ctx, objectType(typeName, field.name, value), value, field.selections);
  }
  return value;
}

const UNRESOLVED = Symbol('unresolved');

function listItemType(parent: string, field: string): string {
  if (field === 'nodes' && parent.endsWith('Connection')) return parent.slice(0, -'Connection'.length);
  if (field === 'fields') return '__Field';
  if (field === 'enumValues') return '__EnumValue';
  return 'Unknown';
}

function objectType(parent: string, field: string, value: unknown): string {
  if (field === '__type') return '__Type';
  if (field === 'viewer') return 'User';
  if (field === 'repository' || field === 'node') {
    if (value && typeof value === 'object' && (value as { __typename?: string }).__typename) {
      return (value as { __typename: string }).__typename;
    }
    return field === 'repository' ? 'Repository' : 'Node';
  }
  if (field === 'owner') return 'RepositoryOwner';
  if (field === 'defaultBranchRef') return 'Ref';
  if (field === 'issue') return 'Issue';
  if (field === 'issues') return 'IssueConnection';
  if (field === 'pullRequest') return 'PullRequest';
  if (field === 'pullRequests') return 'PullRequestConnection';
  if (field === 'files') return 'PullRequestChangedFileConnection';
  if (field === 'createIssue') return 'CreateIssuePayload';
  if (field === 'closeIssue') return 'CloseIssuePayload';
  if (field === 'createPullRequest') return 'CreatePullRequestPayload';
  if (field === 'mergePullRequest') return 'MergePullRequestPayload';
  if (field === 'addComment') return 'AddCommentPayload';
  if (field === 'commentEdge') return 'IssueCommentEdge';
  if (field === 'pageInfo') return 'PageInfo';
  if (parent === 'CreateIssuePayload' && field === 'issue') return 'Issue';
  if (parent === 'CloseIssuePayload' && field === 'issue') return 'Issue';
  if (parent === 'CreatePullRequestPayload' && field === 'pullRequest') return 'PullRequest';
  if (parent === 'MergePullRequestPayload' && field === 'pullRequest') return 'PullRequest';
  if (parent === 'IssueCommentEdge' && field === 'node') return 'IssueComment';
  if (parent === 'IssueConnection' && field === 'nodes') return 'Issue';
  if (parent === '__Type') return '__Type';
  if (parent === 'Query' || parent === 'Mutation') return 'Unknown';
  return parent;
}

function boxedIssue(item: IssueRecord, repo: Repo): Record<string, unknown> {
  return { __typename: 'Issue', item, repo };
}

function boxedPull(item: IssueRecord, repo: Repo): Record<string, unknown> {
  return { __typename: 'PullRequest', item, repo };
}

function boxedRepo(repo: Repo, store: Store): Record<string, unknown> {
  return { __typename: 'Repository', repo, store };
}

function resolver(ctx: ExecContext, typeName: string, source: unknown, field: GqlField): unknown {
  const store = ctx.store;
  if (typeName === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User', user: store.viewer };
    if (field.name === 'repository') {
      const owner = String(arg(ctx, field, 'owner') ?? '');
      const name = String(arg(ctx, field, 'name') ?? '');
      const repo = visibleRepo(store, owner, name);
      return repo ? boxedRepo(repo, store) : null;
    }
    if (field.name === 'node') {
      const id = String(arg(ctx, field, 'id') ?? '');
      const decoded = fromGlobalId(id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepoById(store, decoded.databaseId);
        return repo && repo.owner.toLowerCase() === store.viewer.login.toLowerCase() ? boxedRepo(repo, store) : null;
      }
      if (decoded.type === 'Issue') {
        const found = findItemById(store, decoded.databaseId, 'issue');
        return found ? boxedIssue(found.item, found.repo) : null;
      }
      if (decoded.type === 'PullRequest') {
        const found = findItemById(store, decoded.databaseId, 'pull');
        return found ? boxedPull(found.item, found.repo) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(arg(ctx, field, 'name') ?? '');
      const info = typeFields(name);
      return info ? { __typename: '__Type', name, ...info } : null;
    }
    if (field.name === '__schema') return { __typename: '__Schema' };
    return UNRESOLVED;
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (arg(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.type === 'Repository' ? findRepoById(store, decoded.databaseId) : undefined;
      if (!repo) throw new ExecError('Could not resolve repositoryId');
      const created = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      if ('error' in created) throw new ExecError(`Label does not exist: ${created.name}`);
      return { issue: boxedIssue(created, repo) };
    }
    if (field.name === 'closeIssue') {
      const input = (arg(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.issueId ?? ''));
      const found = decoded ? findItemById(store, decoded.databaseId) : undefined;
      if (!found) throw new ExecError('Could not resolve issueId');
      found.item.state = 'closed';
      found.item.closedAt = new Date().toISOString();
      found.item.updatedAt = found.item.closedAt;
      return { issue: boxedIssue(found.item, found.repo) };
    }
    if (field.name === 'createPullRequest') {
      const input = (arg(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.type === 'Repository' ? findRepoById(store, decoded.databaseId) : undefined;
      if (!repo) throw new ExecError('Could not resolve repositoryId');
      const created = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? repo.defaultBranch),
      });
      if ('error' in created) throw new ExecError(`Validation Failed: ${created.ref} is not a valid ref`);
      return { pullRequest: boxedPull(created, repo) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (arg(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.pullRequestId ?? ''));
      const found = decoded ? findItemById(store, decoded.databaseId, 'pull') : undefined;
      if (!found) throw new ExecError('Could not resolve pullRequestId');
      const result = store.squashMerge(found.repo, found.item);
      if (!result.ok) throw new ExecError(result.message);
      return { pullRequest: boxedPull(found.item, found.repo) };
    }
    if (field.name === 'addComment') {
      const input = (arg(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.subjectId ?? ''));
      const found = decoded ? findItemById(store, decoded.databaseId) : undefined;
      if (!found) throw new ExecError('Could not resolve subjectId');
      const comment = store.addComment(found.repo, found.item.number, String(input.body ?? ''));
      if (!comment) throw new ExecError('Could not add comment');
      return { commentEdge: { node: { __typename: 'IssueComment', id: toGlobalId('IssueComment', comment.id), body: comment.body } } };
    }
    return UNRESOLVED;
  }

  if (typeName === 'User' || typeName === 'RepositoryOwner') {
    const user = (source as { user?: { login: string; id: number; name: string; email: string } }).user
      ?? { login: (source as { login?: string }).login, id: 0, name: '', email: '' };
    if (field.name === 'login') return user.login;
    if (field.name === 'id') return user.id ? toGlobalId('User', user.id) : null;
    if (field.name === 'name') return user.name ?? null;
    if (field.name === 'email') return user.email ?? null;
    if (field.name === 'databaseId') return user.id ?? null;
    return UNRESOLVED;
  }

  if (typeName === 'Repository') {
    const repo = (source as { repo: Repo }).repo;
    if (field.name === 'id') return toGlobalId('Repository', repo.id);
    if (field.name === 'databaseId') return repo.id;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return repo.fullName;
    if (field.name === 'owner') return { __typename: 'RepositoryOwner', login: repo.owner, user: { login: repo.owner, id: store.viewer.login === repo.owner ? store.viewer.id : 0, name: '', email: '' } };
    if (field.name === 'defaultBranchRef') return { name: repo.defaultBranch };
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'description') return repo.description;
    if (field.name === 'isPrivate') return repo.privateFlag;
    if (field.name === 'issue') {
      const number = Number(arg(ctx, field, 'number'));
      const item = repo.items.find((entry) => entry.number === number && entry.kind === 'issue');
      return item ? boxedIssue(item, repo) : null;
    }
    if (field.name === 'pullRequest') {
      const number = Number(arg(ctx, field, 'number'));
      const item = repo.items.find((entry) => entry.number === number && entry.kind === 'pull');
      return item ? boxedPull(item, repo) : null;
    }
    if (field.name === 'issues') return issueConnection(repo, field, ctx);
    if (field.name === 'pullRequests') return pullConnection(repo, field, ctx);
    return UNRESOLVED;
  }

  if (typeName === 'Issue') {
    const { item } = source as { item: IssueRecord; repo: Repo };
    if (field.name === 'id') return toGlobalId('Issue', item.id);
    if (field.name === 'number') return item.number;
    if (field.name === 'title') return item.title;
    if (field.name === 'body') return item.body;
    if (field.name === 'state') return issueState(item);
    return UNRESOLVED;
  }

  if (typeName === 'PullRequest') {
    const { item, repo } = source as { item: IssueRecord; repo: Repo };
    if (field.name === 'id') return toGlobalId('PullRequest', item.id);
    if (field.name === 'number') return item.number;
    if (field.name === 'title') return item.title;
    if (field.name === 'body') return item.body;
    if (field.name === 'state') return pullState(item);
    if (field.name === 'merged') return item.merged === true;
    if (field.name === 'mergedAt') return item.mergedAt ?? null;
    if (field.name === 'headRefName') return item.headRef ?? '';
    if (field.name === 'baseRefName') return item.baseRef ?? repo.defaultBranch;
    if (field.name === 'mergeable') return mergeableOf(store, repo, item);
    if (field.name === 'files') return fileConnection(store, repo, item, field, ctx);
    return UNRESOLVED;
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return (source as { name: string }).name;
    return UNRESOLVED;
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    const conn = source as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return conn.nodes;
    if (field.name === 'pageInfo') return conn.pageInfo;
    return UNRESOLVED;
  }

  if (typeName === 'PageInfo') {
    const info = source as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return info.hasNextPage;
    if (field.name === 'endCursor') return info.endCursor;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
    return UNRESOLVED;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return (source as { path: string }).path;
    if (field.name === 'additions') return (source as { additions?: number }).additions ?? 0;
    if (field.name === 'deletions') return (source as { deletions?: number }).deletions ?? 0;
    return UNRESOLVED;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') return (source as { issue: unknown }).issue;
    return UNRESOLVED;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return (source as { pullRequest: unknown }).pullRequest;
    return UNRESOLVED;
  }
  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return (source as { commentEdge: unknown }).commentEdge;
    return UNRESOLVED;
  }
  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') return (source as { node: unknown }).node;
    return UNRESOLVED;
  }
  if (typeName === 'IssueComment') {
    const comment = source as { id: string; body: string };
    if (field.name === 'id') return comment.id;
    if (field.name === 'body') return comment.body;
    return UNRESOLVED;
  }

  if (typeName === '__Type') {
    const typ = source as { name: string; kind: string; fields?: { name: string }[]; enumValues?: { name: string }[] };
    if (field.name === 'name') return typ.name;
    if (field.name === 'kind') return typ.kind;
    if (field.name === 'fields') return typ.fields ?? [];
    if (field.name === 'enumValues') return typ.enumValues ?? [];
    if (field.name === 'description') return null;
    return UNRESOLVED;
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return (source as { name: string }).name;
    if (field.name === 'description') return null;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
    return UNRESOLVED;
  }

  if (field.name === 'id' && source && typeof source === 'object' && 'id' in (source as object)) {
    return (source as { id: unknown }).id;
  }
  return UNRESOLVED;
}

class ExecError extends Error {}

function mergeableOf(store: Store, repo: Repo, pull: IssueRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const head = repo.resolveRef(pull.headRef ?? '') ?? pull.headSha;
  const base = repo.resolveRef(pull.baseRef ?? repo.defaultBranch) ?? pull.baseSha;
  if (!head || !base) return 'UNKNOWN';
  const ancestor = store.mergeBase(repo, base, head) ?? pull.baseSha ?? base;
  const merged = store.threeWayMerge(repo, ancestor, base, head);
  return merged.ok ? 'MERGEABLE' : 'CONFLICTING';
}

function fileConnection(store: Store, repo: Repo, pull: IssueRecord, field: GqlField, ctx: ExecContext) {
  const head = repo.resolveRef(pull.headRef ?? '') ?? pull.headSha ?? '';
  const base = pull.baseSha ?? repo.resolveRef(pull.baseRef ?? repo.defaultBranch) ?? '';
  const files = store.diffFiles(repo, base, head).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
  const first = Number(arg(ctx, field, 'first') ?? files.length);
  const nodes = files.slice(0, Math.max(0, first));
  return { nodes, pageInfo: { hasNextPage: files.length > nodes.length, endCursor: null } };
}

function issueConnection(repo: Repo, field: GqlField, ctx: ExecContext) {
  const states = asStringList(arg(ctx, field, 'states'));
  const orderBy = (arg(ctx, field, 'orderBy') ?? {}) as { field?: string; direction?: string };
  const first = Math.max(0, Number(arg(ctx, field, 'first') ?? 10));
  const after = arg(ctx, field, 'after');
  let items = repo.items.filter((item) => item.kind === 'issue');
  if (states && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toUpperCase()));
    items = items.filter((item) => wanted.has(issueState(item)));
  }
  const dir = (orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  items = items.slice().sort((a, b) => {
    if (a.number !== b.number) return (a.number - b.number) * dir;
    return 0;
  });
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    if (decoded !== null) {
      const index = items.findIndex((item) => item.number === decoded);
      start = index >= 0 ? index + 1 : items.length;
    }
  }
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? encodeCursor(slice[slice.length - 1]!.number) : null;
  return {
    nodes: slice.map((item) => boxedIssue(item, repo)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function pullConnection(repo: Repo, field: GqlField, ctx: ExecContext) {
  const first = Math.max(0, Number(arg(ctx, field, 'first') ?? 10));
  const items = repo.items.filter((item) => item.kind === 'pull').slice().sort((a, b) => b.number - a.number);
  const slice = items.slice(0, first);
  return {
    nodes: slice.map((item) => boxedPull(item, repo)),
    pageInfo: { hasNextPage: items.length > slice.length, endCursor: slice.length ? encodeCursor(slice[slice.length - 1]!.number) : null },
  };
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item));
}

function encodeCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function executeGraphQL(
  store: Store,
  source: string,
  variables: Record<string, unknown> = {},
): { data: unknown; errors?: GqlError[] } {
  const operation = parseGraphQL(source);
  const ctx: ExecContext = { store, errors: [], variables };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = select(ctx, rootType, {}, operation.selections);
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message }] };
  }
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const auth = authorize(req);
  if (!auth.ok) {
    sendUnauthorized(res, auth);
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendBadRequest(res, 'Body should be a JSON object or array');
    return;
  }
  const runOne = (entry: unknown): { data: unknown; errors?: GqlError[] } => {
    const obj = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const query = typeof obj.query === 'string' ? obj.query : '';
    const variables = obj.variables !== null && typeof obj.variables === 'object' && !Array.isArray(obj.variables)
      ? (obj.variables as Record<string, unknown>)
      : {};
    if (query.trim() === '') return { data: null, errors: [{ message: 'Must provide a query string' }] };
    try {
      return executeGraphQL(store, query, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map((entry) => runOne(entry)));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

void (0 as unknown as NodeType);
