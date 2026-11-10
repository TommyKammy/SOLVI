export const changeStates = [
  { code: 'draft', label: '下書き' },
  { code: 'review', label: '承認待ち' },
  { code: 'approved', label: '承認済み・予定未確定' },
  { code: 'rejected', label: '却下・見直し待ち' },
  { code: 'scheduled', label: '予定確定' },
  { code: 'in_progress', label: '実施中（合成記録）' },
  { code: 'completed', label: '成功（合成記録）' },
  { code: 'failed', label: '失敗（合成記録）' },
  { code: 'cancelled', label: '取り消し済み' },
];
export const changeStateLabel = (v: string) => changeStates.find((s) => s.code === v)?.label ?? v;
const actionLabels: Record<string, string> = {
  create: '計画作成',
  edit: '計画編集・旧承認の失効',
  submit: '承認依頼',
  approve: '承認',
  reject: '却下',
  schedule: '予定確定',
  start: '実施開始の記録',
  result: '実施結果の記録',
  pir: '実施後レビュー',
  cancel: '取り消し',
};
export const changeActionLabel = (v: string) => actionLabels[v] ?? v;
const nextSteps: Record<string, string> = {
  draft: '計画と対象を確認し、別の承認者へ申請してください。',
  review: '指名された承認者の判断を待っています。内容を変える場合は計画を編集し、再申請します。',
  approved: '承認した対象と予定を確認し、予定を確定してください。',
  rejected: '却下理由を確認して計画を編集し、再申請してください。',
  scheduled: '予定期間内に、対象と承認を再確認して合成の実施開始を記録します。',
  in_progress: '合成の実施結果・テスト結果・切戻しの記録を残してください。',
  completed: '成功の記録を保存しました。実施後レビューを残せます。',
  failed: '失敗の記録を保存しました。原因・教訓・再発防止を実施後レビューに残してください。',
  cancelled: '取り消しを記録しました。計画と判断の履歴は保持しています。',
};
export const changeNextStep = (v: string) => nextSteps[v] ?? '現在の状態を確認してください。';
export function jstInput(iso: string | null) {
  return iso ? new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 16) : '';
}
