import { ContextLink } from '../../../components/ContextLink';
import { requireSession } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import { TicketForm } from '../../../components/TicketForm';

export const dynamic = 'force-dynamic';

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const kind = params.kind === 'incident' ? 'incident' : 'request';
  return (
    <main id="main" className="shell">
      <p>
        <ContextLink back href="/portal">
          ポータルへ戻る
        </ContextLink>
      </p>
      <h1>{kind === 'incident' ? '障害を報告する' : 'IT サービスを依頼する'}</h1>
      <p className="lead">
        {kind === 'incident'
          ? '発生している事象を、分かる範囲でお知らせください。'
          : 'アカウントや機器の手配など、ご希望をお知らせください。'}
      </p>
      <TicketForm kind={kind} scope={formScope(session)} />
    </main>
  );
}
