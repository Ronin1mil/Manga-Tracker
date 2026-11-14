import { ClassicLevel } from 'classic-level';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SyncDevice } from '../shared/types';
import { domainMatches } from './chapterParser';
import type { Visit } from './chromeHistory';

// Chrome keeps what it knows about your other signed-in devices (their names and open tabs) in
// "<profile>/Sync Data/LevelDB" as protobuf records. Only the handful of fields below are read.

type Field = { f: number; v: bigint | Buffer };

function decode(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = buf[i++];
      if (b === undefined) throw new Error('truncated');
      r |= BigInt(b & 127) << s;
      if (!(b & 128)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const f = tag >> 3;
    const t = tag & 7;
    if (t === 0) out.push({ f, v: varint() });
    else if (t === 2) {
      const n = Number(varint());
      if (i + n > buf.length) throw new Error('truncated');
      out.push({ f, v: buf.subarray(i, i + n) });
      i += n;
    } else if (t === 1) i += 8;
    else if (t === 5) i += 4;
    else throw new Error('unsupported wire type');
  }
  return out;
}

const str = (fs_: Field[], f: number) => {
  const v = fs_.find((x) => x.f === f)?.v;
  return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
};
const num = (fs_: Field[], f: number) => {
  const v = fs_.find((x) => x.f === f)?.v;
  return typeof v === 'bigint' ? Number(v) : undefined;
};
const msgs = (fs_: Field[], f: number) => fs_.filter((x) => x.f === f && Buffer.isBuffer(x.v)).map((x) => x.v as Buffer);

function kindOf(deviceType?: number, formFactor?: number): SyncDevice['kind'] {
  if (formFactor === 2 || deviceType === 6) return 'phone';
  if (formFactor === 3 || deviceType === 7) return 'tablet';
  if (deviceType && deviceType <= 4) return 'computer';
  return 'other';
}

const toChromeTime = (ms: number) => (ms + 11644473600000) * 1000;

export interface SyncSnapshot {
  devices: SyncDevice[];
  /** Pages in other devices' tabs that are on tracked domains. */
  visits: Visit[];
}

export async function readSyncData(historyPath: string, domains: string[]): Promise<SyncSnapshot> {
  const src = path.join(path.dirname(historyPath), 'Sync Data', 'LevelDB');
  if (!fs.existsSync(src)) return { devices: [], visits: [] };
  const tmp = path.join(os.tmpdir(), `manga-tracker-sync-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // The browser holds LOCK open; everything else can be copied while it runs.
  for (const f of fs.readdirSync(src)) {
    if (f !== 'LOCK') fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  }

  const devices = new Map<string, SyncDevice>();
  const visits: Visit[] = [];
  const tracked = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return domains.some((d) => domainMatches(host, d));
    } catch {
      return false;
    }
  };

  const db = new ClassicLevel<string, Buffer>(tmp, { keyEncoding: 'utf8', valueEncoding: 'buffer', createIfMissing: false });
  try {
    await db.open();
    for await (const [, v] of db.iterator({ gte: 'device_info-dt-', lt: 'device_info-dt.' })) {
      try {
        const d = decode(v);
        const guid = str(d, 1);
        if (!guid) continue;
        devices.set(guid, {
          guid,
          name: str(d, 22) || str(d, 2) || 'Unknown device',
          model: str(d, 11),
          kind: kindOf(num(d, 3), num(d, 20)),
          lastSeen: num(d, 8),
          tabs: [],
        });
      } catch {
        /* skip a record we can't read */
      }
    }
    for await (const [, v] of db.iterator({ gte: 'sessions-dt-', lt: 'sessions-dt.' })) {
      try {
        const top = decode(v);
        const guid = str(top, 1);
        const tab = msgs(top, 3)[0];
        if (!guid || !tab) continue;
        const t = decode(tab);
        const navs = msgs(t, 7).map(decode);
        const current = navs[num(t, 4) ?? navs.length - 1];
        const active = num(t, 14);
        for (const n of navs) {
          const url = str(n, 2);
          if (!url || !tracked(url)) continue;
          visits.push({ kind: 'tab', url, title: str(n, 4), time: toChromeTime(num(n, 9) ?? active ?? 0) });
        }
        const curUrl = current && str(current, 2);
        const dev = devices.get(guid);
        if (dev && curUrl && tracked(curUrl)) dev.tabs.push({ url: curUrl, title: str(current, 4) || curUrl, lastActive: active });
      } catch {
        /* skip a record we can't read */
      }
    }
  } finally {
    await db.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const d of devices.values()) d.tabs.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  return { devices: [...devices.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)), visits };
}
