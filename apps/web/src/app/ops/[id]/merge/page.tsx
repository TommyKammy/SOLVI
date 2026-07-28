import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../../../lib/api';
import { stateLabel } from '../../../../lib/labels';

/**
 * 統合の確認画面 (WP-P2-RELUI-012)。
 *
 * **統合は取り消せない。** 元のチケットは `merged` の終端状態になり、
 * 以降どの状態にも戻せない。だからこの操作だけは**1画面で完結させない**。
 *
 *   1段目: 相手の受付番号を入れる → 相手が誰かを画面に出す
 *   2段目: 件名と状況を**目で確かめてから**理由を書いて実行する
 *
 * 番号を1文字打ち間違えても、実在する別のチケットに当たることがある。
 * 番号だけを見て押させると、その取り違えに気付く機会が無い。
 * 件名を出すのは親切ではなく、**誤操作を止める唯一の手段**である。
 */

export const dynamic = 'force-dynamic';

export default async function MergeTicket({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const session = await api.me();
  if (!session.ok) redirect('/login');

  const source = await api.workspace(id);
  if (!source.ok) {
    if (source.problem.status === 401) redirect('/login');
    notFound();
  }

  // 絞り込んだ値を先に取り出す。サーバアクションの中で `source.data` を
  // 参照すると、閉包の中では絞り込みが効かない。
  const sourceTicket = source.data.ticket;

  const targetNumber = typeof query.target === 'string' ? query.target.trim() : '';
  const lookupFailed = query.notFound !== undefined;
  const mergeFailed = typeof query.error === 'string' ? query.error : undefined;

  // 2段目に進むのは、相手が実在して閲覧できると確かめられたときだけ。
  const target = targetNumber.length > 0 ? await api.lookupByNumber(targetNumber) : null;

  async function findTarget(formData: FormData): Promise<void> {
    'use server';
    const number = String(formData.get('targetTicketNumber') ?? '').trim();
    const found = await api.lookupByNumber(number);
    if (!found.ok) {
      redirect(`/ops/${id}/merge?notFound=1`);
    }
    redirect(`/ops/${id}/merge?target=${encodeURIComponent(found.data.number)}`);
  }

  async function runMerge(formData: FormData): Promise<void> {
    'use server';
    const number = String(formData.get('targetTicketNumber') ?? '').trim();
    const reason = String(formData.get('reason') ?? '').trim();

    const merged = await api.mergeTicket(id, { targetTicketNumber: number, reason });
    if (!merged.ok) {
      const detail = merged.problem.detail ?? merged.problem.title;
      redirect(
        `/ops/${id}/merge?target=${encodeURIComponent(number)}&error=${encodeURIComponent(detail)}`,
      );
    }

    revalidatePath(`/ops/${id}`);
    revalidatePath(`/ops/${merged.data.targetTicketId}`);
    // 統合後は**統合先へ送る**。元のチケットに留まると、
    // 何もできない画面を前にして「次に何をすればよいか」が分からなくなる。
    redirect(
      `/ops/${merged.data.targetTicketId}?merged=${encodeURIComponent(sourceTicket.number)}`,
    );
  }

  const alreadyMerged = sourceTicket.state === 'merged';

  return (
    <main id="main" className="shell">
      <p>
        <Link href={`/ops/${id}`}>この問い合わせへ戻る</Link>
      </p>

      <h1>重複した問い合わせを統合する</h1>
      <p className="lead">
        {sourceTicket.number} {sourceTicket.subject}
      </p>

      {alreadyMerged ? (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>この問い合わせは既に統合されています</h2>
          <p style={{ margin: 0 }}>統合済みの問い合わせをさらに統合することはできません。</p>
        </div>
      ) : (
        <>
          <div className="notice" role="note">
            <h2 style={{ marginTop: 0 }}>統合すると元に戻せません</h2>
            <ul>
              <li>
                <strong>この問い合わせ</strong>が統合され、以降は対応を進められなくなります
              </li>
              <li>
                やり取りと添付は<strong>この問い合わせに残ります</strong>(移動しません)
              </li>
              <li>依頼者から見て履歴が消えることはありません</li>
            </ul>
          </div>

          {lookupFailed && (
            <div className="error-summary" role="alert" tabIndex={-1}>
              <h2>その受付番号の問い合わせは見つかりません</h2>
              <p style={{ margin: 0 }}>
                番号をお確かめください。他の組織の問い合わせは指定できません。
              </p>
            </div>
          )}

          <h2>1. 統合先を探す</h2>
          <form action={findTarget} className="stack">
            <div className="field">
              <label htmlFor="target-number">統合先の受付番号</label>
              <span className="hint" id="target-number-hint">
                残すほうの番号を入れてください。例: INC-2026-000012
              </span>
              <input
                id="target-number"
                name="targetTicketNumber"
                type="text"
                required
                maxLength={64}
                defaultValue={targetNumber}
                aria-describedby="target-number-hint"
                autoComplete="off"
              />
            </div>
            <button type="submit" className="secondary">
              統合先を確認する
            </button>
          </form>

          {target?.ok && (
            <>
              <h2>2. 内容を確かめて統合する</h2>

              {/* **この表が確認そのものである。** 番号だけでなく件名と状況を並べ、
                  どちらが残るのかを言葉で書く。 */}
              <table className="merge-preview">
                <caption className="visually-hidden">統合前後の問い合わせ</caption>
                <tbody>
                  <tr>
                    <th scope="row">統合される(この画面の問い合わせ)</th>
                    <td>
                      {sourceTicket.number} {sourceTicket.subject}
                      <br />
                      <span className="state">{stateLabel(sourceTicket.state)}</span>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">残る(統合先)</th>
                    <td>
                      {target.data.number} {target.data.subject}
                      <br />
                      <span className="state">{stateLabel(target.data.state)}</span>
                    </td>
                  </tr>
                </tbody>
              </table>

              {mergeFailed && (
                <div className="error-summary" role="alert" tabIndex={-1}>
                  <h3 style={{ margin: '0 0 0.5rem' }}>統合できませんでした</h3>
                  <p style={{ margin: 0 }}>{mergeFailed}</p>
                </div>
              )}

              <form action={runMerge} className="stack">
                <input type="hidden" name="targetTicketNumber" value={target.data.number} />
                <div className="field">
                  <label htmlFor="merge-reason">統合の理由</label>
                  {/* 理由は監査に残る。「重複」とだけ書かれても後から判断できないので、
                      何をもって同じと判断したかを促す。 */}
                  <span className="hint" id="merge-reason-hint">
                    例: 同じ利用者から同一事象で二重に起票されたため
                  </span>
                  <input
                    id="merge-reason"
                    name="reason"
                    type="text"
                    required
                    maxLength={500}
                    aria-describedby="merge-reason-hint"
                  />
                </div>
                <button type="submit" className="danger">
                  {sourceTicket.number} を {target.data.number} へ統合する
                </button>
              </form>
            </>
          )}
        </>
      )}
    </main>
  );
}
