import { GLPIClient, GLPIError, inputText, readConfig } from './client';
const COOKIE = 'solvi_glpi_session';
const response = (body: unknown, status = 200, cookie?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  });
async function json(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new GLPIError(415);
  const reader = request.body?.getReader();
  if (!reader) throw new GLPIError(400);
  let data = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 64000) {
      await reader.cancel();
      throw new GLPIError(413);
    }
    data += decoder.decode(value, { stream: true });
  }
  data += decoder.decode();
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new GLPIError(400);
  }
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new GLPIError(400);
}
/** Fixed endpoint allowlist, never an arbitrary GLPI proxy. */
export async function handleGLPI(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  try {
    const config = readConfig(env);
    const client = new GLPIClient(config, fetcher);
    const url = new URL(request.url);
    let origin: URL;
    try {
      origin = new URL(env.GLPI_UI_ORIGIN ?? '');
    } catch {
      throw new GLPIError(503);
    }
    if (
      // Next.js dev reconstructs request.url with localhost even when bound to
      // 127.0.0.1. Validate the actual HTTP Host against our fixed public origin.
      // Never trust X-Forwarded-Host or use this value to choose an upstream.
      origin.origin !==
        (request.headers.has('host')
          ? `${url.protocol}//${request.headers.get('host')}`
          : url.origin) ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      !(
        origin.protocol === 'https:' ||
        (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))
      )
    )
      throw new GLPIError(403);
    const secure = origin.protocol === 'https:';
    const cookie = (token: string, maxAge = 3600) =>
      `${COOKIE}=${token}; Path=/api/glpi; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    const mutation = request.method !== 'GET';
    if (mutation && request.headers.get('origin') !== origin.origin) throw new GLPIError(403);
    const path = url.pathname.slice('/api/glpi/'.length);
    if (
      path !== 'session' &&
      path !== 'tickets' &&
      !/^tickets\/[1-9]\d{0,9}(?:\/(reply|process))?$/.test(path)
    )
      throw new GLPIError(404);
    if (path === 'session' && request.method === 'POST') {
      const body = await json(request);
      keys(body, ['username', 'password']);
      if (typeof body.password !== 'string' || !body.password.length || body.password.length > 1000)
        throw new GLPIError(400);
      const token = await client.login(inputText(body.username, 200), body.password);
      return response({ ok: true }, 200, cookie(token));
    }
    const token = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!token) throw new GLPIError(401);
    const expectedActor = request.headers.get('x-solvi-glpi-actor');
    if (path !== 'session' && (mutation || expectedActor)) {
      const actor = await client.actor(token);
      if (expectedActor !== `${actor.id}:${actor.entityId}:${actor.role}`) throw new GLPIError(409);
    }
    if (path === 'session' && request.method === 'DELETE') {
      await client.logout(token);
      return response({ ok: true }, 200, cookie('', 0));
    }
    if (path === 'session' && request.method === 'GET') return response(await client.actor(token));
    if (path === 'tickets' && request.method === 'GET') {
      const page = url.searchParams.get('page') ?? '0';
      if (!/^\d{1,4}$/.test(page)) throw new GLPIError(400);
      return response(await client.list(token, Number(page)));
    }
    if (path === 'tickets' && request.method === 'POST') {
      const body = await json(request);
      keys(body, ['title', 'content']);
      return response(
        {
          id: await client.create(
            token,
            inputText(body.title, 200),
            inputText(body.content, 10000),
          ),
        },
        201,
      );
    }
    const match = /^tickets\/([1-9]\d{0,9})(?:\/(reply|process))?$/.exec(path);
    if (!match) throw new GLPIError(404);
    const id = Number(match[1]);
    if (!match[2] && request.method === 'GET') return response(await client.detail(token, id));
    if (match[2] === 'reply' && request.method === 'POST') {
      const body = await json(request);
      keys(body, ['content', 'private']);
      if (typeof body.private !== 'boolean') throw new GLPIError(400);
      await client.reply(token, id, inputText(body.content, 10000), body.private);
      return response({ ok: true }, 201);
    }
    if (match[2] === 'process' && request.method === 'POST') {
      const body = await json(request);
      keys(body, ['action']);
      if (body.action !== 'claim' && body.action !== 'pending' && body.action !== 'resume')
        throw new GLPIError(400);
      await client.process(token, id, body.action);
      return response({ ok: true });
    }
    throw new GLPIError(405);
  } catch (error) {
    const status = error instanceof GLPIError ? error.status : 503;
    return response(
      {
        error:
          status === 401
            ? 'ログインが必要です。'
            : status === 404
              ? '対象を表示できません。'
              : '操作を完了できませんでした。送信後のエラーは保存済みの可能性があります。一覧・会話を確認してから再操作してください。',
      },
      status,
    );
  }
}
