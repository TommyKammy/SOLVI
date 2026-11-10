import { describe, expect, it, vi } from 'vitest';
import { GLPIClient, GLPIError, readConfig } from '../../apps/web/src/lib/glpi/client';
import { handleGLPI } from '../../apps/web/src/lib/glpi/http';
const alice = 'syntheticAliceSession';
const bob = 'syntheticBobSession99';
const agent = 'syntheticAgentSession';
const other = 'syntheticOtherSession';
const unknown = 'syntheticUnknownRole1';
const env = {
  NODE_ENV: 'test',
  GLPI_UI_ENABLED: 'true',
  GLPI_API_URL: 'http://127.0.0.1:8088/apirest.php',
  GLPI_UI_ORIGIN: 'http://127.0.0.1:3000',
  GLPI_ENTITY_ID: '1',
  GLPI_REQUESTER_PROFILES: '1',
  GLPI_AGENT_PROFILES: '6',
};
const config = readConfig(env);
function fixture() {
  const sessions: Record<string, { user: number; entity: number; profile: number }> = {
    [alice]: { user: 11, entity: 1, profile: 1 },
    [bob]: { user: 12, entity: 1, profile: 1 },
    [agent]: { user: 21, entity: 1, profile: 6 },
    [other]: { user: 31, entity: 2, profile: 1 },
    [unknown]: { user: 41, entity: 1, profile: 4 },
  };
  const tickets = [
    {
      id: 1,
      entities_id: 1,
      name: 'Alice request',
      content: 'Synthetic laptop request',
      status: 1,
      is_deleted: 0,
      requester: 11,
    },
    {
      id: 2,
      entities_id: 1,
      name: 'Bob private title',
      content: 'Bob only body',
      status: 1,
      is_deleted: 0,
      requester: 12,
    },
    {
      id: 3,
      entities_id: 2,
      name: 'Other entity',
      content: 'Other organization body',
      status: 1,
      is_deleted: 0,
      requester: 31,
    },
    {
      id: 4,
      entities_id: 1,
      name: 'GLPI denied item',
      content: 'Forbidden',
      status: 1,
      is_deleted: 0,
      requester: 11,
    },
  ];
  const notes = [
    {
      id: 101,
      itemtype: 'Ticket',
      items_id: 1,
      content: 'Public response',
      is_private: 0,
      users_id: 21,
    },
    {
      id: 102,
      itemtype: 'Ticket',
      items_id: 1,
      content: 'Private agent note',
      is_private: 1,
      users_id: 21,
    },
    {
      id: 103,
      itemtype: 'Ticket',
      items_id: 2,
      content: 'Wrong parent note',
      is_private: 0,
      users_id: 21,
    },
  ];
  const writes: Array<{ path: string; input: Record<string, unknown>; user: number }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.split('/apirest.php/')[1];
    const headers = new Headers(init?.headers);
    const token = headers.get('Session-Token') ?? '';
    const session = sessions[token];
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (path === 'initSession') return reply({ session_token: alice });
    if (!session)
      return reply(['ERROR_SESSION_TOKEN_INVALID', 'synthetic upstream sensitive details'], 401);
    if (path === 'getFullSession')
      return reply({
        session: {
          glpiID: session.user,
          glpiactive_entity: session.entity,
          glpiactiveprofile: { id: session.profile },
          glpicsrftokens: 'must never return',
        },
      });
    if (path === 'killSession') {
      delete sessions[token];
      return reply(true);
    }
    const input = init?.body
      ? (JSON.parse(String(init.body)).input as Record<string, unknown>)
      : undefined;
    if (input) writes.push({ path, input, user: session.user });
    if (path === 'Ticket' && init?.method === 'POST' && input) {
      tickets.push({
        id: 5,
        entities_id: Number(input.entities_id),
        name: String(input.name),
        content: String(input.content),
        status: 1,
        is_deleted: 0,
        requester: Number(input._users_id_requester),
      });
      return reply({ id: 5 }, 201);
    }
    if (path === 'Ticket') return reply(tickets.map(({ id }) => ({ id })));
    if (path === 'ITILFollowup' && input) {
      const noteId = 101 + notes.length;
      notes.push({
        id: noteId,
        itemtype: String(input.itemtype),
        items_id: Number(input.items_id),
        content: String(input.content),
        is_private: Number(input.is_private),
        users_id: session.user,
      });
      return reply({ id: noteId }, 201);
    }
    const parts = path.split('/');
    const id = Number(parts[1]);
    if (parts[0] === 'ITILFollowup') return reply(notes.find((note) => note.id === id));
    const ticket = tickets.find((ticket) => ticket.id === id);
    if (!ticket || id === 4) return reply(['ERROR_RIGHT', 'sensitive upstream title'], 403);
    if (parts[2] === 'Ticket_User')
      return reply([{ tickets_id: id, type: 1, users_id: ticket.requester }]);
    if (parts[2] === 'ITILFollowup') return reply(notes); // Deliberate over-return to exercise defense in depth.
    if (init?.method === 'PUT' && input) {
      ticket.status = Number(input.status);
      return reply([{ [id]: true }]);
    }
    return reply({
      ...ticket,
      _documents: [{ name: 'secret-attachment.pdf', url: 'https://private.invalid/file' }],
      links: [{ href: 'private' }],
    });
  }) as unknown as typeof fetch;
  return { client: new GLPIClient(config, fetcher), fetcher, writes, tickets, sessions };
}
function req(
  path: string,
  method = 'GET',
  token = alice,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://127.0.0.1:3000/api/glpi/${path}`, {
    method,
    headers: {
      Cookie: `solvi_glpi_session=${token}`,
      Origin: env.GLPI_UI_ORIGIN,
      'Content-Type': 'application/json',
      'X-SOLVI-GLPI-Actor': token === agent ? '21:1:agent' : '11:1:requester',
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
describe('GLPI 12 contract-shaped synthetic transport (no real GLPI, no listener)', () => {
  it('creates as requester, then lists and reads persisted fixture ticket', async () => {
    const f = fixture();
    const id = await f.client.create(alice, 'New request', 'Please help');
    expect(f.writes[0].input).toMatchObject({ entities_id: 1, _users_id_requester: 11 });
    expect((await f.client.list(alice, 0)).tickets.map((t) => t.id)).toEqual([1, 5]);
    expect(await f.client.detail(alice, id)).toMatchObject({
      title: 'New request',
      content: 'Please help',
    });
  });
  it('isolates requesters even if upstream collections over-return', async () => {
    const f = fixture();
    expect((await f.client.list(bob, 0)).tickets.map((t) => t.id)).toEqual([2]);
    await expect(f.client.detail(alice, 2)).rejects.toMatchObject({ status: 404 });
    await expect(f.client.reply(alice, 2, 'no', false)).rejects.toMatchObject({ status: 404 });
    expect(f.writes).toEqual([]);
  });
  it.each([alice, agent])(
    'denies cross-entity ticket and omits GLPI denied rows for %s',
    async (token) => {
      const f = fixture();
      await expect(f.client.detail(token, 3)).rejects.toMatchObject({ status: 404 });
      expect((await f.client.list(token, 0)).tickets.every((t) => ![3, 4].includes(t.id))).toBe(
        true,
      );
    },
  );
  it.each([other, unknown, 'syntheticRevokedSession'])(
    'rejects foreign, unknown role or revoked session %s',
    async (token) => {
      const f = fixture();
      await expect(f.client.list(token, 0)).rejects.toBeInstanceOf(GLPIError);
      await expect(f.client.create(token, 'test', 'test')).rejects.toBeInstanceOf(GLPIError);
      expect(f.writes).toEqual([]);
    },
  );
  it('redacts private notes, unrelated notes, attachments and raw links', async () => {
    const f = fixture();
    const value = await f.client.detail(alice, 1);
    expect(value.followups.map((n) => n.id)).toEqual([101]);
    expect(JSON.stringify(value)).not.toMatch(
      /Private agent|Wrong parent|private.invalid|secret-attachment|links|glpicsrftokens/,
    );
  });
  it('agent claims, responds, adds private note and sets pending/resume', async () => {
    const f = fixture();
    await f.client.process(agent, 1, 'claim');
    expect(f.writes[0].input).toMatchObject({ id: 1, _users_id_assign: 21, status: 2 });
    await f.client.reply(agent, 1, 'Agent response', false);
    await f.client.reply(agent, 1, 'Internal', true);
    await f.client.process(agent, 1, 'pending');
    expect(f.tickets[0].status).toBe(4);
    await f.client.process(agent, 1, 'resume');
    expect(f.tickets[0].status).toBe(2);
    expect((await f.client.detail(agent, 1)).followups.some((n) => n.private)).toBe(true);
    expect((await f.client.detail(alice, 1)).followups.every((n) => !n.private)).toBe(true);
  });
  it('requester cannot write private notes or process tickets', async () => {
    const f = fixture();
    await expect(f.client.reply(alice, 1, 'no', true)).rejects.toMatchObject({ status: 403 });
    await expect(f.client.process(alice, 1, 'claim')).rejects.toMatchObject({ status: 403 });
    expect(f.writes).toEqual([]);
  });
  it('rechecks session before writes and stops terminal-state processing', async () => {
    const f = fixture();
    await f.client.detail(alice, 1);
    delete f.sessions[alice];
    await expect(f.client.reply(alice, 1, 'no', false)).rejects.toMatchObject({ status: 401 });
    f.tickets[0].status = 6;
    await expect(f.client.process(agent, 1, 'pending')).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toEqual([]);
  });
  it('escapes user HTML before sending to GLPI and does not expose rich document markup', async () => {
    const f = fixture();
    await f.client.create(alice, '<script>alert(1)</script>', '<img src=x>');
    expect(f.writes[0].input.content).toBe('&lt;img src=x&gt;');
    f.tickets[0].content = '<img src="https://private.invalid/file">Hello';
    expect((await f.client.detail(alice, 1)).content).toBe('Hello');
  });
  it('uses individual Basic login and discards session on logout', async () => {
    const f = fixture();
    expect(await f.client.login('synthetic', 'synthetic-password')).toBe(alice);
    const init = vi.mocked(f.fetcher).mock.calls[0][1]!;
    expect(new Headers(init.headers).get('Authorization')).toMatch(/^Basic /);
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    await f.client.logout(alice);
    await expect(f.client.actor(alice)).rejects.toMatchObject({ status: 401 });
  });
  it.each([-1, 1001, 0.5])('bounds pagination %s', async (page) => {
    await expect(fixture().client.list(alice, page)).rejects.toMatchObject({ status: 400 });
  });
  it('does not disclose upstream errors and does not retry uncertain writes', async () => {
    const f = fixture();
    const fetcher = vi
      .fn(f.fetcher)
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              session: { glpiID: 11, glpiactive_entity: 1, glpiactiveprofile: { id: 1 } },
            }),
          ),
      )
      .mockRejectedValueOnce(new Error('upstream credential'));
    const client = new GLPIClient(config, fetcher);
    await expect(client.create(alice, 'Title', 'Body')).rejects.toThrow('GLPI request failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('GLPI BFF boundary', () => {
  it('accepts the configured Host when Next reconstructs a localhost URL', async () => {
    const f = fixture();
    const original = req('tickets');
    const request = new Request('http://localhost:3000/api/glpi/tickets', {
      headers: { ...Object.fromEntries(original.headers), Host: '127.0.0.1:3000' },
    });
    expect((await handleGLPI(request, env, f.fetcher)).status).toBe(200);
  });
  it.each(['attacker.invalid', '127.0.0.1:4000', 'localhost:3000'])(
    'rejects unexpected Host %s even with a spoofed forwarded host',
    async (host) => {
      const f = fixture();
      const request = req('tickets', 'GET', alice, undefined, {
        Host: host,
        'X-Forwarded-Host': '127.0.0.1:3000',
      });
      expect((await handleGLPI(request, env, f.fetcher)).status).toBe(403);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it('sets HttpOnly scoped cookie and never returns session token in JSON', async () => {
    const f = fixture();
    const result = await handleGLPI(
      req('session', 'POST', '', { username: 'synthetic', password: 'synthetic-password' }),
      env,
      f.fetcher,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain(
      'Path=/api/glpi; HttpOnly; SameSite=Strict; Max-Age=3600',
    );
    expect(await result.text()).not.toContain(alice);
    expect(result.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['https://attacker.invalid', 'null', ''])(
    'rejects CSRF origin %s before contacting GLPI',
    async (origin) => {
      const f = fixture();
      expect(
        (
          await handleGLPI(
            req('tickets', 'POST', alice, { title: 'x', content: 'x' }, { Origin: origin }),
            env,
            f.fetcher,
          )
        ).status,
      ).toBe(403);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects stale actor scope after account switch', async () => {
    const f = fixture();
    expect(
      (
        await handleGLPI(
          req(
            'tickets/1/reply',
            'POST',
            agent,
            { content: 'no', private: false },
            { 'X-SOLVI-GLPI-Actor': '11:1:requester' },
          ),
          env,
          f.fetcher,
        )
      ).status,
    ).toBe(409);
    expect(f.writes).toEqual([]);
  });
  it.each(['entities_id', '_users_id_requester', 'users_id', 'profiles_id'])(
    'rejects injected field %s',
    async (key) => {
      const f = fixture();
      expect(
        (
          await handleGLPI(
            req('tickets', 'POST', alice, { title: 'x', content: 'x', [key]: 42 }),
            env,
            f.fetcher,
          )
        ).status,
      ).toBe(400);
      expect(f.writes).toEqual([]);
    },
  );
  it.each(['Document/1', 'tickets/1/Document', 'tickets/1/attachments', 'changeActiveProfile'])(
    'has no arbitrary proxy or attachment route %s',
    async (path) => {
      const f = fixture();
      expect((await handleGLPI(req(path), env, f.fetcher)).status).toBe(404);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects missing authentication', async () => {
    const f = fixture();
    expect((await handleGLPI(req('tickets', 'GET', ''), env, f.fetcher)).status).toBe(401);
  });
  it.each([
    { GLPI_UI_ENABLED: 'false' },
    { NODE_ENV: 'production' },
    { GLPI_API_URL: 'http://external.invalid/apirest.php' },
    { GLPI_API_URL: 'https://user:password@glpi.invalid/apirest.php' },
    { GLPI_AGENT_PROFILES: '1' },
    { GLPI_ENTITY_ID: '' },
  ])('fails closed on unsafe config %s', async (override) => {
    const f = fixture();
    expect((await handleGLPI(req('tickets'), { ...env, ...override }, f.fetcher)).status).toBe(503);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('returns sanitized DTO and completes requester/agent route flow', async () => {
    const f = fixture();
    const created = await handleGLPI(
      req('tickets', 'POST', alice, { title: 'Synthetic request', content: 'Synthetic body' }),
      env,
      f.fetcher,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 5 });
    expect(
      (
        await handleGLPI(
          req('tickets/5/process', 'POST', agent, { action: 'claim' }),
          env,
          f.fetcher,
        )
      ).status,
    ).toBe(200);
    const detail = await handleGLPI(req('tickets/5'), env, f.fetcher);
    expect(await detail.json()).toMatchObject({ status: 2, title: 'Synthetic request' });
  });
});

describe('GLPI failure and response contracts', () => {
  it('recognizes the GLPI 12 exhausted-range code without exposing its total', async () => {
    const f = fixture();
    const transport: typeof fetch = async (url, init) =>
      String(url).includes('Ticket?')
        ? new Response(JSON.stringify(['ERROR_RANGE_EXCEED_TOTAL', 'total=private']), {
            status: 400,
          })
        : f.fetcher(url, init);
    expect(await new GLPIClient(config, transport).list(alice, 2)).toEqual({
      actor: { id: 11, entityId: 1, role: 'requester' },
      tickets: [],
      more: false,
    });
  });
  it('rejects malformed privacy rather than treating it as public', async () => {
    const f = fixture();
    const transport: typeof fetch = async (url, init) =>
      String(url).includes('/Ticket/1/ITILFollowup?')
        ? new Response(
            JSON.stringify([
              { id: 101, items_id: 1, itemtype: 'Ticket', content: 'hidden', users_id: 21 },
            ]),
          )
        : f.fetcher(url, init);
    await expect(new GLPIClient(config, transport).detail(alice, 1)).rejects.toMatchObject({
      status: 502,
    });
  });
  it('rejects a false update response even on HTTP 200', async () => {
    const f = fixture();
    const transport: typeof fetch = async (url, init) =>
      init?.method === 'PUT'
        ? new Response(JSON.stringify([{ '1': false, message: 'private backend detail' }]))
        : f.fetcher(url, init);
    await expect(
      new GLPIClient(config, transport).process(agent, 1, 'claim'),
    ).rejects.toMatchObject({ status: 502 });
  });
  it('does not report a zero create ID as a success', async () => {
    const f = fixture();
    const transport: typeof fetch = async (url, init) =>
      init?.method === 'POST' ? new Response(JSON.stringify({ id: 0 })) : f.fetcher(url, init);
    await expect(new GLPIClient(config, transport).create(alice, 'x', 'x')).rejects.toMatchObject({
      status: 502,
    });
  });
  it('sets Secure on HTTPS and clears cookie only after upstream logout succeeds', async () => {
    const f = fixture();
    const secureEnv = { ...env, GLPI_UI_ORIGIN: 'https://solvi.invalid' };
    const login = new Request('https://solvi.invalid/api/glpi/session', {
      method: 'POST',
      headers: { Origin: secureEnv.GLPI_UI_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'synthetic', password: 'synthetic' }),
    });
    const result = await handleGLPI(login, secureEnv, f.fetcher);
    expect(result.headers.get('set-cookie')).toContain('; Secure');
    const logout = await handleGLPI(req('session', 'DELETE'), env, f.fetcher);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(f.sessions[alice]).toBeUndefined();
  });
  it('rejects oversized JSON and unknown actions with no write', async () => {
    const f = fixture();
    expect(
      (
        await handleGLPI(
          req('tickets', 'POST', alice, { title: 'x', content: 'x'.repeat(65000) }),
          env,
          f.fetcher,
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await handleGLPI(
          req('tickets/1/process', 'POST', agent, { action: 'delete' }),
          env,
          f.fetcher,
        )
      ).status,
    ).toBe(400);
    expect(f.writes).toEqual([]);
  });
});
