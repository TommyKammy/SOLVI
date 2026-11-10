import type { CatalogField, CatalogItem } from './api';

export type CatalogTemplate = {
  code: string;
  title: string;
  description: string;
  targetLabel: string;
  allowedDurations: number[];
  fields: CatalogField[];
};
const text = (key: string, label: string, maxLength = 100): CatalogField => ({
  key,
  label,
  type: 'text',
  required: true,
  maxLength,
});
const confirm: CatalogField = {
  key: 'simulation_confirm',
  label: '合成情報での模擬申請であり、実際の作成・権限付与・貸出は行われないことを確認しました',
  type: 'checkbox',
  required: true,
};

// 通常のカタログ定義として保存する。入力値は外部操作のパラメータにしない。
export const catalogTemplates: CatalogTemplate[] = [
  {
    code: 'local-contractor-account',
    title: '業務委託者アカウント登録',
    description:
      '業務委託者の受入れに必要な情報を申請します。委託会社、利用者名、連絡用メール、受入れ部署・責任者、開始・終了希望日をご用意ください。承認後は模擬結果を記録し、実アカウントは作成しません。合成情報だけでお試しください。',
    targetLabel: '業務委託者の受入れ（模擬）',
    allowedDurations: [7, 30, 90, 180],
    fields: [
      text('contractor_company', '委託会社名'),
      text('contractor_name', '利用者の表示名'),
      text('contact_email', '連絡用メール（合成情報）', 200),
      text('sponsor', '受入れ部署・責任者'),
      text('start_date', '開始希望日（YYYY-MM-DD）', 10),
      text('end_date', '終了希望日（YYYY-MM-DD）', 10),
      confirm,
    ],
  },
  {
    code: 'local-box-request',
    title: 'Box利用申請',
    description:
      'Boxで行いたい業務と扱う情報を申請します。利用部署、利用用途、情報の種類、社外共有の予定をご用意ください。フォルダやグループのIDは入力しません。承認後は模擬結果を記録し、Boxの権限は変更しません。',
    targetLabel: 'Box利用の受付（模擬）',
    allowedDurations: [7, 30, 90, 180],
    fields: [
      text('department', '利用部署'),
      {
        key: 'box_purpose',
        label: '利用用途',
        type: 'select',
        required: true,
        options: ['社内資料の閲覧', '社内資料の編集・共有', '社外との資料共有'],
      },
      {
        key: 'information',
        label: '扱う情報の種類（機密情報・実データを記載しない）',
        type: 'textarea',
        required: true,
        maxLength: 500,
      },
      {
        key: 'external_sharing',
        label: '社外共有の予定',
        type: 'select',
        required: true,
        options: ['予定なし', '予定あり（別途確認が必要）'],
      },
      confirm,
    ],
  },
  {
    code: 'local-pc-loan',
    title: 'PC貸与申請',
    description:
      '業務用PCの貸与希望を申請します。利用部署、端末の希望、受取方法、貸与開始・返却希望日をご用意ください。承認後は模擬結果を記録します。在庫の予約、資産の割当、実際の貸出は行いません。',
    targetLabel: 'PC貸与の受付（模擬）',
    allowedDurations: [7, 30, 90, 180],
    fields: [
      text('department', '利用部署'),
      {
        key: 'device_type',
        label: '希望する端末',
        type: 'select',
        required: true,
        options: ['WindowsノートPC', 'MacノートPC', 'IT担当者に相談'],
      },
      {
        key: 'pickup',
        label: '受取方法',
        type: 'select',
        required: true,
        options: ['社内窓口', '配送の相談'],
      },
      text('loan_start', '貸与開始希望日（YYYY-MM-DD）', 10),
      text('return_date', '返却希望日（YYYY-MM-DD）', 10),
      confirm,
    ],
  },
];

export function templateDefinition(
  template: CatalogTemplate,
  approverId: string,
): CatalogItem['definition'] {
  return {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: template.targetLabel,
    allowedDurations: template.allowedDurations,
    maxReasonLength: 2000,
    fields: template.fields,
    approval: { mode: 'fixed', approverId },
  };
}
