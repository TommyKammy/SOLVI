import { api } from '../../../lib/api';

export const dynamic = 'force-dynamic';
export async function GET() {
  const result = await api.me();
  return Response.json(
    result.ok ? { scope: `${result.data.organizationId}:${result.data.userId}` } : {},
    {
      status: result.ok ? 200 : result.problem.status,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
