import { api } from '../../../../../lib/api';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    r = await api.assetImport(id);
  if (!r.ok) return Response.json(r.problem, { status: r.problem.status });
  return Response.json(
    {
      importId: id,
      rows: r.data.plan.rows
        .filter((row) => row.operation === 'error')
        .map(({ row, externalId, assetTag, issues }) => ({ row, externalId, assetTag, issues })),
    },
    {
      headers: {
        'content-disposition': `attachment; filename="asset-import-${id}-errors.json"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}
