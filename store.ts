import { bootIdentity, DEFAULT_BRANCH, type Identity, type ScenarioUser } from './identity.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromPaths,
  collectFromCommitNoParents,
  collectReachable,
  flattenTree,
  formatIdentity,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  storeObject,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
} from './git/objects.ts';
import { readPack } from './git/pack.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  number: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  // pull-only
  headRef?: string;
  baseRef?: string;
  headSha?: string;
  baseSha?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  privateFlag: boolean;
  description: string;
  defaultBranch: string;
  readonly createdAt: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly items: IssueRecord[] = [];
  readonly comments = new Map<number, Comment[]>();
  nextNumber = 1;
  private nextLabelId = 1;

  allocLabelId(): number {
    return this.nextLabelId++;
  }

  constructor(fields: {
    id: number;
    owner: string;
    name: string;
    privateFlag: boolean;
    description: string;
    defaultBranch: string;
  }) {
    this.id = fields.id;
    this.owner = fields.owner;
    this.name = fields.name;
    this.privateFlag = fields.privateFlag;
    this.description = fields.description;
    this.defaultBranch = fields.defaultBranch;
    this.createdAt = new Date().toISOString();
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup: ObjectLookup = (oid: string): GitObject | undefined => this.objects.get(oid.toLowerCase());

  putObject(type: GitObjectType, data: Uint8Array): GitObject {
    const object = storeObject(type, data);
    this.objects.set(object.oid, object);
    return object;
  }

  putExisting(object: GitObject): void {
    this.objects.set(object.oid, object);
  }

  resolveRef(name: string): string | undefined {
    if (name === 'HEAD') {
      return this.refs.get(`refs/heads/${this.defaultBranch}`);
    }
    if (this.refs.has(name)) return this.refs.get(name);
    if (this.refs.has(`refs/heads/${name}`)) return this.refs.get(`refs/heads/${name}`);
    if (this.refs.has(`refs/tags/${name}`)) return this.refs.get(`refs/tags/${name}`);
    return undefined;
  }

  headTarget(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  peel(oid: string): string {
    let current = oid;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const object = this.lookup(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  branchTips(): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  listCommits(tip: string | undefined): Array<{ sha: string; message: string }> {
    if (!tip) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    let current: string | undefined = tip;
    while (current && !seen.has(current)) {
      seen.add(current);
      const object = this.lookup(current);
      if (!object || object.type !== 'commit') break;
      const view = parseCommit(object.data);
      out.push({ sha: current, message: view.message.replace(/\n$/, '') });
      current = view.parents[0];
    }
    return out;
  }

  fileAt(treeOid: string, path: string): { mode: string; oid: string } | undefined {
    const parts = path.split('/').filter(Boolean);
    let oid = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = this.lookup(oid);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
      oid = entry.oid;
    }
    return undefined;
  }

  treeOidAt(commitOid: string): string | undefined {
    const object = this.lookup(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  listDir(treeOid: string, dirPath: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> {
    let oid = treeOid;
    const parts = dirPath.split('/').filter(Boolean);
    for (const part of parts) {
      const object = this.lookup(oid);
      if (!object || object.type !== 'tree') return [];
      const entry = parseTree(object.data).find((e) => e.name === part);
      if (!entry) return [];
      oid = entry.oid;
    }
    const object = this.lookup(oid);
    if (!object || object.type !== 'tree') return [];
    const prefix = parts.join('/');
    return parseTree(object.data).map((entry) => {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      return {
        type: isDir ? 'dir' as const : 'file' as const,
        name: entry.name,
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
        sha: entry.oid,
      };
    });
  }
}

export class Store {
  readonly identity: Identity;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 10_000;
  private nextIssueId = 20_000;
  private nextCommentId = 30_000;

  constructor(identity: Identity = bootIdentity()) {
    this.identity = identity;
  }

  get viewer(): ScenarioUser {
    return this.identity.viewer;
  }

  get stranger(): ScenarioUser {
    return this.identity.stranger;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** A repository is only visible when the owner is the token's viewer login. */
  visibleRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== this.viewer.login.toLowerCase()) return undefined;
    return this.getRepo(owner, name);
  }

  listViewerRepos(): Repo[] {
    const login = this.viewer.login.toLowerCase();
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === login);
  }

  createRepo(input: { name: string; private?: boolean; description?: string; defaultBranch?: string }): Repo | { error: 'exists' } {
    const name = input.name;
    if (this.getRepo(this.viewer.login, name)) return { error: 'exists' };
    const repo = new Repo({
      id: this.nextRepoId++,
      owner: this.viewer.login,
      name,
      privateFlag: input.private === true,
      description: input.description ?? '',
      defaultBranch: input.defaultBranch ?? DEFAULT_BRANCH,
    });
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.visibleRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    return true;
  }

  identityLine(whenSec = Math.floor(Date.now() / 1000)): string {
    return formatIdentity(this.viewer.name, this.viewer.email, whenSec);
  }

  commitOn(
    repo: Repo,
    options: {
      branch: string;
      message: string;
      mutate: (files: Map<string, { mode: string; oid: string }>) => void;
      allowUnborn?: boolean;
    },
  ): { commit: GitObject } | { error: 'unborn' | 'missing-branch' } {
    const ref = options.branch.startsWith('refs/') ? options.branch : `refs/heads/${options.branch}`;
    const parent = repo.refs.get(ref);
    if (!parent && !options.allowUnborn && repo.refs.size > 0 && !repo.refs.has(ref)) {
      // Creating a commit on a brand-new named branch without an existing ref is allowed
      // only when the caller is writing the default branch of an unborn repo.
      if (ref !== `refs/heads/${repo.defaultBranch}`) return { error: 'missing-branch' };
    }
    const files = new Map<string, { mode: string; oid: string }>();
    if (parent) {
      const tree = repo.treeOidAt(parent);
      if (tree) {
        for (const [path, value] of flattenTree(tree, repo.lookup)) files.set(path, value);
      }
    }
    options.mutate(files);
    const treeOid = buildTreeFromPaths(files, (type, data) => repo.putObject(type, data));
    const data = buildCommit({
      tree: treeOid,
      parents: parent ? [parent] : [],
      author: this.identityLine(),
      message: options.message,
    });
    const commit = repo.putObject('commit', data);
    repo.refs.set(ref, commit.oid);
    return { commit };
  }

  putContents(
    repo: Repo,
    options: {
      path: string;
      content: Buffer;
      message: string;
      branch?: string;
      sha?: string;
    },
  ):
    | { status: 201 | 200; commit: GitObject; blob: GitObject }
    | { status: 409; message: string }
    | { status: 404; message: string }
    | { status: 422; message: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const unborn = tip === undefined && (repo.refs.size === 0 || branch === repo.defaultBranch);
    if (tip === undefined && !unborn) return { status: 404, message: `Branch ${branch} not found` };

    let currentBlob: string | undefined;
    if (tip) {
      const tree = repo.treeOidAt(tip);
      if (tree) currentBlob = repo.fileAt(tree, options.path)?.oid;
    }
    if (currentBlob) {
      if (!options.sha) return { status: 422, message: 'sha was not supplied, so the file was not updated' };
      if (options.sha.toLowerCase() !== currentBlob) {
        return { status: 409, message: 'is at a different sha than the one provided' };
      }
    } else if (options.sha) {
      return { status: 409, message: 'is at a different sha than the one provided' };
    }

    const blob = repo.putObject('blob', options.content);
    const result = this.commitOn(repo, {
      branch,
      message: options.message,
      allowUnborn: unborn,
      mutate: (files) => {
        files.set(options.path, { mode: '100644', oid: blob.oid });
      },
    });
    if ('error' in result) return { status: 404, message: 'Not Found' };
    return { status: currentBlob ? 200 : 201, commit: result.commit, blob };
  }

  deleteContents(
    repo: Repo,
    options: { path: string; message: string; branch?: string; sha: string },
  ): { status: 200; commit: GitObject } | { status: 404; message: string } | { status: 409; message: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return { status: 404, message: 'Not Found' };
    const tree = repo.treeOidAt(tip);
    const current = tree ? repo.fileAt(tree, options.path) : undefined;
    if (!current) return { status: 404, message: 'Not Found' };
    if (options.sha.toLowerCase() !== current.oid) {
      return { status: 409, message: 'is at a different sha than the one provided' };
    }
    const result = this.commitOn(repo, {
      branch,
      message: options.message,
      mutate: (files) => {
        files.delete(options.path);
      },
    });
    if ('error' in result) return { status: 404, message: 'Not Found' };
    return { status: 200, commit: result.commit };
  }

  createLabel(repo: Repo, name: string, color = 'ededed'): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: repo.allocLabelId(), name, color: color.replace(/^#/, '') };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: Repo,
    input: { title: string; body: string; labels?: readonly string[] },
  ): IssueRecord | { error: 'unknown-label'; name: string } {
    for (const name of input.labels ?? []) {
      if (!repo.labels.has(name)) return { error: 'unknown-label', name };
    }
    const now = new Date().toISOString();
    const issue: IssueRecord = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      kind: 'issue',
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      user: this.viewer.login,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.items.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    input: { title: string; body: string; head: string; base: string },
  ): IssueRecord | { error: 'missing-ref'; ref: string } {
    const headSha = repo.resolveRef(input.head);
    const baseSha = repo.resolveRef(input.base);
    if (!headSha) return { error: 'missing-ref', ref: input.head };
    if (!baseSha) return { error: 'missing-ref', ref: input.base };
    const now = new Date().toISOString();
    const pull: IssueRecord = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      kind: 'pull',
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [],
      user: this.viewer.login,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.items.push(pull);
    return pull;
  }

  addComment(repo: Repo, number: number, body: string): Comment | undefined {
    const item = repo.items.find((entry) => entry.number === number);
    if (!item) return undefined;
    const comment: Comment = {
      id: this.nextCommentId++,
      number,
      body,
      user: this.viewer.login,
      createdAt: new Date().toISOString(),
    };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestors = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.lookup(oid);
      if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = repo.lookup(oid);
      if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return undefined;
  }

  diffFiles(
    repo: Repo,
    baseSha: string,
    headSha: string,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; content?: Buffer }> {
    const baseCommit = repo.lookup(baseSha);
    const headCommit = repo.lookup(headSha);
    if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return [];
    const baseTree = flattenTree(parseCommit(baseCommit.data).tree, repo.lookup);
    const headTree = flattenTree(parseCommit(headCommit.data).tree, repo.lookup);
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const before = baseTree.get(path);
      const after = headTree.get(path);
      if (before?.oid === after?.oid) continue;
      let status = 'modified';
      if (!before && after) status = 'added';
      else if (before && !after) status = 'removed';
      const beforeText = before ? (repo.lookup(before.oid)?.data.toString('utf8') ?? '') : '';
      const afterText = after ? (repo.lookup(after.oid)?.data.toString('utf8') ?? '') : '';
      const counts = lineCounts(beforeText, afterText);
      files.push({ filename: path, status, ...counts });
    }
    return files;
  }

  threeWayMerge(
    repo: Repo,
    baseSha: string,
    oursSha: string,
    theirsSha: string,
  ): { ok: true; tree: string } | { ok: false; message: string } {
    const treeOf = (sha: string): Map<string, { mode: string; oid: string }> => {
      const object = repo.lookup(sha);
      if (!object || object.type !== 'commit') return new Map();
      return flattenTree(parseCommit(object.data).tree, repo.lookup);
    };
    const base = treeOf(baseSha);
    const ours = treeOf(oursSha);
    const theirs = treeOf(theirsSha);
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const result = new Map<string, { mode: string; oid: string }>();
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? '') === (y?.oid ?? '');
      if (same(o, t)) {
        if (o) result.set(path, o);
        continue;
      }
      if (same(o, b)) {
        if (t) result.set(path, t);
        continue;
      }
      if (same(t, b)) {
        if (o) result.set(path, o);
        continue;
      }
      return { ok: false, message: `Merge conflict in ${path}` };
    }
    const tree = buildTreeFromPaths(result, (type, data) => repo.putObject(type, data));
    return { ok: true, tree };
  }

  squashMerge(
    repo: Repo,
    pull: IssueRecord,
  ): { ok: true; sha: string; message: string } | { ok: false; status: 405 | 404 | 422; message: string } {
    if (pull.kind !== 'pull') return { ok: false, status: 404, message: 'Not Found' };
    if (pull.merged || pull.state === 'closed') {
      return { ok: false, status: 405, message: 'Pull request is not mergeable' };
    }
    const headRef = pull.headRef ?? '';
    const baseRef = pull.baseRef ?? repo.defaultBranch;
    const headSha = repo.resolveRef(headRef);
    const baseSha = repo.resolveRef(baseRef);
    if (!headSha || !baseSha) return { ok: false, status: 405, message: 'Head or base branch is missing' };
    const base = this.mergeBase(repo, baseSha, headSha) ?? pull.baseSha ?? baseSha;
    const merged = this.threeWayMerge(repo, base, baseSha, headSha);
    if (!merged.ok) return { ok: false, status: 405, message: merged.message };
    const message = pull.title;
    const data = buildCommit({
      tree: merged.tree,
      parents: [baseSha],
      author: this.identityLine(),
      message,
    });
    const commit = repo.putObject('commit', data);
    repo.refs.set(baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`, commit.oid);
    const now = new Date().toISOString();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.mergeCommitSha = commit.oid;
    return { ok: true, sha: commit.oid, message: 'Pull Request successfully merged' };
  }

  ingestPack(repo: Repo, pack: Uint8Array): { ok: true; count: number } | { ok: false; detail: string } {
    if (pack.length === 0) return { ok: true, count: 0 };
    try {
      const read = readPack(pack, { resolveBase: repo.lookup });
      if (!read.checksumOk) return { ok: false, detail: 'checksum mismatch' };
      for (const object of read.objects.values()) repo.putExisting(object);
      return { ok: true, count: read.objects.size };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (newOid === ZERO_OID) return true;
    if (oldOid === ZERO_OID) return true;
    if (oldOid === newOid) return true;
    return isAncestor(oldOid, newOid, repo.lookup);
  }

  objectsToSend(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    options: { depth?: number; clientShallow?: readonly string[] } = {},
  ): {
    objects: GitObject[];
    shallow: string[];
    unshallow: string[];
  } {
    const haveSet = new Set(haves.filter((oid) => isObjectId(oid)));
    const shallowHaves = new Set((options.clientShallow ?? []).filter((oid) => isObjectId(oid)));
    const haveObjects = new Set<string>();
    for (const oid of haveSet) {
      if (shallowHaves.has(oid)) {
        for (const item of collectFromCommitNoParents(oid, repo.lookup)) haveObjects.add(item);
      } else {
        for (const item of collectReachable([oid], repo.lookup, { allowMissing: true })) haveObjects.add(item);
      }
    }
    const shallow: string[] = [];
    const unshallow: string[] = [];

    if (options.depth != null && options.depth > 0) {
      const commits: string[] = [];
      const seen = new Set<string>();
      let frontier = [...wants.filter((oid) => isObjectId(oid))];
      for (let depth = 0; depth < options.depth; depth += 1) {
        const next: string[] = [];
        for (const oid of frontier) {
          if (seen.has(oid)) continue;
          seen.add(oid);
          const object = repo.lookup(oid);
          if (!object || object.type !== 'commit') continue;
          commits.push(oid);
          next.push(...parseCommit(object.data).parents);
        }
        frontier = next;
      }
      const commitSet = new Set(commits);
      for (const oid of commits) {
        const object = repo.lookup(oid);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        const hasMissingParent = parents.some((parent) => !commitSet.has(parent));
        if (hasMissingParent) shallow.push(oid);
      }
      // A previously shallow commit that now has its parent included is unshallowed.
      // Callers pass current shallow boundaries via wants/haves; we also treat every
      // requested want that is no longer on the boundary as unshallow.
      for (const oid of wants) {
        if (commitSet.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
      }
      const needed = new Set<string>();
      for (const oid of commits) {
        for (const item of collectFromCommitNoParents(oid, repo.lookup)) {
          if (!haveObjects.has(item)) needed.add(item);
        }
      }
      const objects: GitObject[] = [];
      for (const oid of needed) {
        const object = repo.lookup(oid);
        if (object) objects.push(object);
      }
      return { objects, shallow, unshallow };
    }

    const wanted = collectReachable(wants.filter((oid) => isObjectId(oid)), repo.lookup, { allowMissing: true });
    const objects: GitObject[] = [];
    for (const oid of wanted) {
      if (haveObjects.has(oid)) continue;
      const object = repo.lookup(oid);
      if (object) objects.push(object);
    }
    return { objects, shallow, unshallow };
  }
}

function lineCounts(before: string, after: string): { additions: number; deletions: number; changes: number } {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after === '' ? [] : after.split(/\r?\n/);
  if (before.endsWith('\n') || before === '') {
    /* keep trailing empty skipped consistently */
  }
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      dp[i + 1]![j + 1] = a[i] === b[j] ? dp[i]![j]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[a.length]![b.length]!;
  const deletions = a.length - lcs;
  const additions = b.length - lcs;
  return { additions, deletions, changes: additions + deletions };
}

export function blobTextShaPreview(_oid: string): void {
  void hashObject;
}
