import Link from 'next/link';
import { FreshserviceIcon } from '../../../components/FreshserviceIcon';
import { requireSession } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import { safeReturnTo } from '../../../lib/navigation';
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
  const returnTo = safeReturnTo(params.returnTo) ?? '/portal';
  return (
    <main id="main" className="shell support-ticket-report">
      <header className="support-page-heading">
        <div>
          <Link className="support-back" href={returnTo}>
            <FreshserviceIcon name="arrow-left" size={16} />
            {returnTo === '/portal' ? 'ポータルに戻る' : '元の画面へ戻る'}
          </Link>
          <h1>{kind === 'incident' ? '障害を報告する' : 'IT サービスを依頼する'}</h1>
          <p className="lead">
            {kind === 'incident'
              ? '発生していることを、分かる範囲でお知らせください。'
              : 'アカウントや機器の手配など、ご希望をお知らせください。'}
          </p>
        </div>
      </header>
      <TicketForm kind={kind} scope={formScope(session)} />
    </main>
  );
}
