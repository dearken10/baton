/**
 * IPC contract round-trip tests.
 *
 * Per PRD F10.1 + Architect: "single most important test in the suite."
 * Every control verb is round-tripped through its request and response
 * schemas. If schemas drift, this test fails and CI blocks the merge.
 *
 * This is the snapshot test: the SHAPE of every verb's request and
 * response is asserted by parsing a representative value through the
 * schema. If you add a verb, add a fixture here.
 */

import { describe, expect, it } from 'vitest';
import {
  AppEvent,
  AppMetaResponse,
  ControlVerbs,
  PingRequest,
  PingResponse,
  PtyDataFrame,
  SessionListRequest,
  SessionListResponse,
  SessionStatus,
} from './ipc.js';

describe('control verb registry', () => {
  it('exposes every verb with a request + response schema', () => {
    const names = Object.keys(ControlVerbs).sort();
    expect(names).toMatchInlineSnapshot(`
      [
        "app.meta",
        "app.ping",
        "project.add",
        "project.list",
        "project.pickFolder",
        "pty.resize",
        "pty.write",
        "session.kill",
        "session.list",
        "session.resume",
        "session.spawn",
      ]
    `);
    for (const v of names) {
      const def = ControlVerbs[v as keyof typeof ControlVerbs];
      expect(def.request).toBeDefined();
      expect(def.response).toBeDefined();
    }
  });
});

describe('app.ping', () => {
  it('parses an empty request', () => {
    expect(PingRequest.parse({})).toEqual({});
  });
  it('parses a well-formed response', () => {
    const out = PingResponse.parse({ ok: true, ts: 1 });
    expect(out).toEqual({ ok: true, ts: 1 });
  });
  it('rejects ok:false', () => {
    expect(() => PingResponse.parse({ ok: false, ts: 1 })).toThrow();
  });
});

describe('app.meta', () => {
  it('parses a well-formed response', () => {
    const r = AppMetaResponse.parse({
      version: '0.0.1',
      electron: '32.3.3',
      node: '20.10.0',
      platform: 'darwin',
    });
    expect(r.version).toBe('0.0.1');
  });
  it('rejects missing fields', () => {
    expect(() => AppMetaResponse.parse({ version: 'x' })).toThrow();
  });
});

describe('session.list', () => {
  it('parses empty request + response', () => {
    expect(SessionListRequest.parse({})).toEqual({});
    expect(SessionListResponse.parse({ sessions: [] })).toEqual({ sessions: [] });
  });
  it('parses a session row', () => {
    const r = SessionListResponse.parse({
      sessions: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          projectId: 'proj-1',
          backendId: 'mock',
          branch: 'main',
          worktreePath: '/tmp/wt',
          claudeSessionId: null,
          status: 'running',
          startedAt: Date.now(),
          endedAt: null,
          tokensIn: 0,
          tokensOut: 0,
          lastSummary: null,
        },
      ],
    });
    expect(r.sessions[0]?.status).toBe('running');
  });
  it('rejects unknown status enum', () => {
    expect(() =>
      SessionListResponse.parse({
        sessions: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            projectId: 'proj-1',
            backendId: 'mock',
            branch: 'main',
            worktreePath: '/tmp/wt',
          claudeSessionId: null,
            status: 'about-to-happen',
            startedAt: 0,
            endedAt: null,
            tokensIn: 0,
            tokensOut: 0,
            lastSummary: null,
          },
        ],
      })
    ).toThrow();
  });
});

describe('SessionStatus enum', () => {
  it('exposes the v1 set (incl. disconnected for Remote SSH)', () => {
    expect(SessionStatus.options.slice().sort()).toMatchInlineSnapshot(`
      [
        "disconnected",
        "done",
        "errored",
        "idle",
        "needs-input",
        "paused",
        "running",
      ]
    `);
  });
});

describe('AppEvent', () => {
  it('parses session.status_changed', () => {
    const e = AppEvent.parse({
      seq: 1,
      bootId: '11111111-1111-1111-1111-111111111111',
      ts: Date.now(),
      type: 'session.status_changed',
      sessionId: '22222222-2222-2222-2222-222222222222',
      from: 'idle',
      to: 'running',
    });
    expect(e.type).toBe('session.status_changed');
  });
  it('parses session.summarized', () => {
    const e = AppEvent.parse({
      seq: 1,
      bootId: '11111111-1111-1111-1111-111111111111',
      ts: Date.now(),
      type: 'session.summarized',
      sessionId: '22222222-2222-2222-2222-222222222222',
      summary: 'editing svc.ts',
    });
    if (e.type !== 'session.summarized') throw new Error('discriminator');
    expect(e.summary).toBe('editing svc.ts');
  });
  it('rejects an unknown event type', () => {
    expect(() =>
      AppEvent.parse({
        seq: 1,
        bootId: '11111111-1111-1111-1111-111111111111',
        ts: 0,
        type: 'made-up',
      })
    ).toThrow();
  });
});

describe('PtyDataFrame', () => {
  it('parses base64 frames', () => {
    const f = PtyDataFrame.parse({
      sessionId: '33333333-3333-3333-3333-333333333333',
      data: btoa('hello\n'),
    });
    expect(typeof f.data).toBe('string');
  });
});
