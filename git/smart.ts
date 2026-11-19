import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorize,
  pathOf,
  queryOf,
  readBody,
  sendBuffer,
  sendJson,
  sendUnauthorized,
} from '../http.ts';
import { ZERO_OID, isObjectId, parseTag } from './objects.ts';
import { writePack } from './pack.ts';
import { decodePktLines, encodePktLine, encodePktLines, packetText, pktLineFlush, sidebandFrames, type GitPacket } from './pkt.ts';
import type { Repo, Store } from '../store.ts';

const UPLOAD_ADV = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADV = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function wantsV2(req: IncomingMessage): boolean {
  const value = req.headers['git-protocol'];
  const header = Array.isArray(value) ? value.join(',') : value ?? '';
  return /version=2/.test(header);
}

function gitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return { owner: decodeURIComponent(match[1]!), repo: decodeURIComponent(match[2]!), rest: match[3] ?? '' };
}

function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const defaultRef = repo.headTarget();
  const headOid = repo.refs.get(defaultRef);
  if (headOid) refs.push({ oid: headOid, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.lookup(oid);
    let peeled: string | undefined;
    if (object?.type === 'tag') peeled = repo.peel(oid);
    refs.push({ oid, name, peeled: peeled && peeled !== oid ? peeled : undefined });
  }
  return refs;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta'
      : 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/' +
        repo.defaultBranch +
        ' object-format=sha1 agent=github-core-clone/1.0';
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return encodePktLines(items);
  }
  refs.forEach((ref, index) => {
    const line = `${ref.oid} ${ref.name}`;
    items.push(index === 0 ? `${line}\0${caps}\n` : `${line}\n`);
    if (ref.peeled) items.push(`${ref.peeled} ${ref.name}^{}\n`);
  });
  items.push('flush');
  return encodePktLines(items);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter ofs-delta\n',
    'server-option\n',
    'object-format=sha1\n',
    'agent=github-core-clone/1.0\n',
    'flush',
  ]);
}

function textLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    const text = packetText(packet);
    if (text === null) continue;
    lines.push(text.replace(/\n$/, ''));
  }
  return lines;
}

function handleLsRefs(repo: Repo, packets: readonly GitPacket[]): Buffer {
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const args = textLines(packets.slice(delimIndex + 1));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Array<string | 'flush'> = [];
  const defaultRef = repo.headTarget();
  const headOid = repo.refs.get(defaultRef);
  if (keep('HEAD') && prefixes.length === 0) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${defaultRef}`;
      out.push(`${line}\n`);
    } else if (unborn) {
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:${defaultRef}`;
      out.push(`${line}\n`);
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return encodePktLines(out);
}

function handleFetch(repo: Repo, store: Store, packets: readonly GitPacket[]): Buffer {
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const args = textLines(packets.slice(delimIndex + 1));
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }

  const result = store.objectsToSend(repo, wants, haves, { depth, clientShallow });
  const parts: Buffer[] = [];

  if (depth != null) {
    const info: Array<string | 'flush' | 'delim'> = ['shallow-info\n'];
    for (const oid of result.shallow) info.push(`shallow ${oid}\n`);
    for (const oid of result.unshallow) {
      if (clientShallow.includes(oid) || wants.includes(oid)) info.push(`unshallow ${oid}\n`);
    }
    info.push('delim');
    parts.push(encodePktLines(info));
  }

  if (result.objects.length === 0) {
    // Nothing to send: end after optional shallow-info. A 0-object pack is also valid
    // but transferring no pack matches fetch-nothing-new.
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  }

  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(result.objects);
  parts.push(sidebandFrames(1, pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleReceivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { packets, rest } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    const text = packetText(packet);
    if (text === null) continue;
    const line = text.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const command = nul >= 0 ? line.slice(0, nul) : line;
    const space1 = command.indexOf(' ');
    const space2 = command.indexOf(' ', space1 + 1);
    if (space1 < 0 || space2 < 0) continue;
    const oldOid = command.slice(0, space1);
    const newOid = command.slice(space1 + 1, space2);
    const ref = command.slice(space2 + 1);
    commands.push({ oldOid, newOid, ref });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    const ingested = store.ingestPack(repo, rest);
    if (!ingested.ok) {
      unpackOk = false;
      unpackDetail = ingested.detail.replace(/\s+/g, ' ').slice(0, 80);
    }
  }

  const reports: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
        reports.push(`ng ${command.ref} bad-object-id`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (!current) {
          reports.push(`ng ${command.ref} missing`);
          continue;
        }
        if (current !== command.oldOid) {
          reports.push(`ng ${command.ref} stale`);
          continue;
        }
        repo.refs.delete(command.ref);
        reports.push(`ok ${command.ref}`);
        continue;
      }
      if (!repo.lookup(command.newOid)) {
        reports.push(`ng ${command.ref} missing-object`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current) {
          reports.push(`ng ${command.ref} already exists`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reports.push(`ok ${command.ref}`);
        continue;
      }
      if ((current ?? ZERO_OID) !== command.oldOid) {
        reports.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (!store.isFastForward(repo, command.oldOid, command.newOid)) {
        reports.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push(`ok ${command.ref}`);
    }
  } else {
    for (const command of commands) reports.push(`ng ${command.ref} unpacker error`);
  }

  const reportLines: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  for (const line of reports) reportLines.push(`${line}\n`);
  reportLines.push('flush');
  const report = encodePktLines(reportLines);
  return Buffer.concat([sidebandFrames(1, report), pktLineFlush()]);
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const parsed = gitPath(pathOf(req));
  if (!parsed) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const auth = authorize(req);
  if (!auth.ok) {
    sendUnauthorized(res, auth);
    return true;
  }

  const repo = store.visibleRepo(parsed.owner, parsed.repo);

  try {
    if (parsed.rest === '/info/refs' || parsed.rest === '/info/refs/') {
      const service = queryOf(req).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'Missing or invalid service' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const type = service === 'git-upload-pack' ? UPLOAD_ADV : RECEIVE_ADV;
      const body =
        service === 'git-upload-pack' && wantsV2(req) ? v2Advertisement() : v0Advertisement(repo, service);
      sendBuffer(res, 200, body, type);
      return true;
    }

    if (parsed.rest === '/git-upload-pack' && method === 'POST') {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const raw = await readBody(req);
      const { packets } = decodePktLines(raw);
      const commandLine = textLines(packets).find((line) => line.startsWith('command='));
      const command = commandLine?.slice('command='.length);
      let body: Buffer;
      if (command === 'ls-refs') body = handleLsRefs(repo, packets);
      else if (command === 'fetch') body = handleFetch(repo, store, packets);
      else body = encodePktLines(['ERR unknown command\n', 'flush']);
      sendBuffer(res, 200, body, UPLOAD_RESULT);
      return true;
    }

    if (parsed.rest === '/git-receive-pack' && method === 'POST') {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const raw = await readBody(req);
      const body = handleReceivePack(repo, store, raw);
      sendBuffer(res, 200, body, RECEIVE_RESULT);
      return true;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch {
    // Malformed pkt-line or pack must not take the process down.
    if (!res.headersSent) sendJson(res, 400, { message: 'malformed git request' });
    return true;
  }
}

// Keep parseTag imported for peel completeness in case we expand later.
void parseTag;
