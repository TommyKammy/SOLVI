const states: Record<string, string> = {
  stocked: '在庫',
  in_use: '使用中',
  repair: '修理中',
  retired: '廃止',
};
const kinds: Record<string, string> = {
  pc: 'PC',
  server: 'サーバー',
  vm: '仮想マシン',
  network: 'ネットワーク機器',
  mobile: 'モバイル端末',
  saas: 'SaaS',
};
export const assetStateLabel = (code: string) => states[code] ?? code;
export const assetKindLabel = (code: string) => kinds[code] ?? code;
