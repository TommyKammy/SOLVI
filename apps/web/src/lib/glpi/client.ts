/** ADR-0107. Server transport only; credentials never enter a browser DTO or logs. */
export class GLPIError extends Error {
  constructor(public readonly status: number) {
    super('GLPI request failed');
  }
}
export type GLPIConfig = {
  baseUrl: string;
  entityId: number;
  requesterProfiles: number[];
  agentProfiles: number[];
  appToken?: string;
};
export type Actor = { id: number; entityId: number; role: 'requester' | 'agent' };
export type Ticket = { id: number; title: string; content: string; status: number };
export type Followup = { id: number; content: string; private: boolean; authorId: number };
export type Detail = Ticket & { followups: Followup[]; moreFollowups: boolean };
export const states: Record<number, string> = {
  1: '新規',
  2: '対応中（割当済み）',
  3: '対応中（計画済み）',
  4: '保留',
  5: '解決済み',
  6: '終了',
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GLPIError(502);
  return value as Record<string, unknown>;
};
const integer = (value: unknown): number => {
  if (!(
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^\d+$/.test(value))
  ))
    throw new GLPIError(502);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new GLPIError(502);
  return result;
};
const array = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new GLPIError(502);
  return value.map(object);
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new GLPIError(502);
  // Never render GLPI rich text, embedded documents, links or images as HTML.
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');
};
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
export function inputText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new GLPIError(400);
  return value.trim();
}
export function readConfig(env: NodeJS.ProcessEnv): GLPIConfig {
  if (env.GLPI_UI_ENABLED !== 'true' || env.NODE_ENV === 'production') throw new GLPIError(503);
  try {
    const url = new URL(env.GLPI_API_URL ?? '');
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/apirest.php') ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
      )
    ) {
      throw new Error();
    }
    const profiles = (value: string | undefined) => {
      if (!value || !/^\d+(,\d+)*$/.test(value)) throw new Error();
      return value.split(',').map(integer);
    };
    const requesterProfiles = profiles(env.GLPI_REQUESTER_PROFILES);
    const agentProfiles = profiles(env.GLPI_AGENT_PROFILES);
    if (requesterProfiles.some((id) => agentProfiles.includes(id))) throw new Error();
    return {
      baseUrl: url.href,
      entityId: integer(env.GLPI_ENTITY_ID),
      requesterProfiles,
      agentProfiles,
      ...(env.GLPI_APP_TOKEN ? { appToken: env.GLPI_APP_TOKEN } : {}),
    };
  } catch {
    throw new GLPIError(503);
  }
}
export class GLPIClient {
  constructor(
    private config: GLPIConfig,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async call(
    path: string,
    token?: string,
    method = 'GET',
    body?: unknown,
    authorization?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Session-Token'] = token;
    if (authorization) headers.Authorization = authorization;
    if (this.config.appToken) headers['App-Token'] = this.config.appToken;
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GLPIError(503);
    }
    if (!response.ok) {
      // GLPI 12 uses 400 with a stable error code for an exhausted item range.
      if (response.status === 400 && method === 'GET') {
        const problem: unknown = await response.json().catch(() => null);
        if (Array.isArray(problem) && problem[0] === 'ERROR_RANGE_EXCEED_TOTAL')
          throw new GLPIError(416);
      }
      throw new GLPIError(
        response.status === 401
          ? 401
          : [403, 404].includes(response.status)
            ? 404
            : response.status === 416
              ? 416
              : 502,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new GLPIError(502);
    }
  }
  async login(username: string, password: string): Promise<string> {
    if (username.includes(':')) throw new GLPIError(400);
    const result = object(
      await this.call(
        'initSession',
        undefined,
        'GET',
        undefined,
        `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      ),
    );
    if (
      typeof result.session_token !== 'string' ||
      !/^[a-zA-Z0-9]{16,256}$/.test(result.session_token)
    )
      throw new GLPIError(502);
    const token = result.session_token;
    try {
      await this.actor(token);
    } catch (error) {
      await this.logout(token).catch(() => undefined);
      throw error;
    }
    return token;
  }
  async logout(token: string): Promise<void> {
    await this.call('killSession', token);
  }
  async actor(token: string): Promise<Actor> {
    if (!/^[a-zA-Z0-9]{16,256}$/.test(token)) throw new GLPIError(401);
    const session = object(object(await this.call('getFullSession', token)).session);
    const id = integer(session.glpiID);
    const entityId = integer(session.glpiactive_entity);
    const profile = integer(object(session.glpiactiveprofile).id);
    if (id < 1 || entityId !== this.config.entityId) throw new GLPIError(403);
    const role = this.config.agentProfiles.includes(profile)
      ? 'agent'
      : this.config.requesterProfiles.includes(profile)
        ? 'requester'
        : null;
    if (!role) throw new GLPIError(403);
    return { id, entityId, role };
  }
  private async visible(token: string, actor: Actor, id: number): Promise<Ticket> {
    if (!Number.isSafeInteger(id) || id < 1) throw new GLPIError(404);
    const row = object(await this.call(`Ticket/${id}?get_hateoas=false`, token));
    if (
      integer(row.id) !== id ||
      integer(row.entities_id) !== actor.entityId ||
      integer(row.is_deleted) !== 0
    )
      throw new GLPIError(404);
    if (actor.role === 'requester') {
      const members = array(
        await this.call(`Ticket/${id}/Ticket_User?range=0-99&get_hateoas=false`, token),
      );
      if (
        !members.some(
          (member) =>
            integer(member.tickets_id) === id &&
            integer(member.type) === 1 &&
            integer(member.users_id) === actor.id,
        )
      ) {
        throw new GLPIError(404);
      }
    }
    const status = integer(row.status);
    if (!(status in states)) throw new GLPIError(502);
    return { id, title: text(row.name), content: text(row.content), status };
  }
  async list(token: string, page: number) {
    const actor = await this.actor(token);
    if (!Number.isSafeInteger(page) || page < 0 || page > 1000) throw new GLPIError(400);
    let rows: Record<string, unknown>[];
    try {
      rows = array(
        await this.call(
          `Ticket?only_id=true&range=${page * 20}-${page * 20 + 19}&sort=id&order=DESC&get_hateoas=false`,
          token,
        ),
      );
    } catch (error) {
      if (error instanceof GLPIError && error.status === 416)
        return { actor, tickets: [], more: false };
      throw error;
    }
    const tickets: Ticket[] = [];
    for (const row of rows) {
      try {
        tickets.push(await this.visible(token, actor, integer(row.id)));
      } catch (error) {
        if (!(error instanceof GLPIError && error.status === 404)) throw error;
      }
    }
    return { actor, tickets, more: rows.length === 20 };
  }
  async detail(token: string, id: number): Promise<Detail> {
    const actor = await this.actor(token);
    const ticket = await this.visible(token, actor, id);
    const rows = array(
      await this.call(
        `Ticket/${id}/ITILFollowup?range=0-99&sort=id&order=DESC&get_hateoas=false`,
        token,
      ),
    );
    const followups: Followup[] = [];
    for (const row of rows) {
      if (row.itemtype !== 'Ticket' || integer(row.items_id) !== id) continue;
      const privacy = integer(row.is_private);
      if (privacy !== 0 && privacy !== 1) throw new GLPIError(502);
      if (privacy === 1 && actor.role !== 'agent') continue;
      // Subitem collections are not a substitute for per-item GLPI authorization.
      const checked = object(
        await this.call(`ITILFollowup/${integer(row.id)}?get_hateoas=false`, token),
      );
      if (
        checked.itemtype !== 'Ticket' ||
        integer(checked.items_id) !== id ||
        integer(checked.is_private) !== privacy
      )
        throw new GLPIError(502);
      followups.push({
        id: integer(checked.id),
        content: text(checked.content),
        private: privacy === 1,
        authorId: integer(checked.users_id),
      });
    }
    return { ...ticket, followups: followups.reverse(), moreFollowups: rows.length === 100 };
  }
  async create(token: string, title: string, content: string): Promise<number> {
    const actor = await this.actor(token);
    const result = object(
      await this.call('Ticket', token, 'POST', {
        input: {
          name: escape(inputText(title, 200)),
          content: escape(inputText(content, 10000)),
          entities_id: actor.entityId,
          _users_id_requester: actor.id,
          type: 2,
        },
      }),
    );
    const id = integer(result.id);
    if (id < 1) throw new GLPIError(502);
    return id;
  }
  async reply(token: string, id: number, content: string, isPrivate: boolean): Promise<void> {
    const actor = await this.actor(token);
    if (isPrivate && actor.role !== 'agent') throw new GLPIError(403);
    await this.visible(token, actor, id);
    const result = object(
      await this.call('ITILFollowup', token, 'POST', {
        input: {
          itemtype: 'Ticket',
          items_id: id,
          content: escape(inputText(content, 10000)),
          is_private: isPrivate ? 1 : 0,
        },
      }),
    );
    if (integer(result.id) < 1) throw new GLPIError(502);
  }
  async process(token: string, id: number, action: 'claim' | 'pending' | 'resume'): Promise<void> {
    const actor = await this.actor(token);
    if (actor.role !== 'agent') throw new GLPIError(403);
    const ticket = await this.visible(token, actor, id);
    if (ticket.status >= 5) throw new GLPIError(409);
    const input =
      action === 'claim'
        ? { id, _users_id_assign: actor.id, status: 2 }
        : { id, status: action === 'pending' ? 4 : 2 };
    const result = array(await this.call(`Ticket/${id}`, token, 'PUT', { input }));
    if (!result.some((row) => row[String(id)] === true)) throw new GLPIError(502);
  }
}
