/**
 * 優先度の導出(FR-TKT-009)。
 *
 * Impact(影響範囲)× Urgency(緊急度)から**決定論的**に決める。
 * AIは提案までで、確定には関与しない(ADR-0007)。
 * 同じ入力から常に同じ優先度が出ることが、SLA計測と監査の前提になる。
 */

export const IMPACT_LEVELS = ['low', 'medium', 'high'] as const;
export const URGENCY_LEVELS = ['low', 'medium', 'high'] as const;
export const PRIORITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export type Impact = (typeof IMPACT_LEVELS)[number];
export type Urgency = (typeof URGENCY_LEVELS)[number];
export type Priority = (typeof PRIORITY_LEVELS)[number];

/**
 * 優先度マトリクス。行=Impact、列=Urgency。
 *
 * critical は「影響が広く、かつ急ぐ」場合だけに限る。
 * critical を出しやすくすると、運用上どれも critical になって優先度が意味を失う。
 */
const MATRIX: Record<Impact, Record<Urgency, Priority>> = {
  high: { high: 'critical', medium: 'high', low: 'medium' },
  medium: { high: 'high', medium: 'medium', low: 'low' },
  low: { high: 'medium', medium: 'low', low: 'low' },
};

export function derivePriority(impact: Impact, urgency: Urgency): Priority {
  return MATRIX[impact][urgency];
}

/**
 * AIや利用者が提示した優先度が、規則から導かれる値と一致するかを確認する。
 * 一致しない場合でも例外にせず、呼び出し側が「提案」として扱えるようにする
 * (提案の採否は人間が決める / FR-TKT-009・FR-AI-002)。
 */
export function isDerivedPriority(impact: Impact, urgency: Urgency, candidate: Priority): boolean {
  return derivePriority(impact, urgency) === candidate;
}
