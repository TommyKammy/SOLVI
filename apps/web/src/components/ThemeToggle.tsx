'use client';
import { useCallback, useEffect, useState } from 'react';
import { FreshserviceIcon } from './FreshserviceIcon';

type Theme = 'light' | 'dark';

/** ブラウザに保存する表示テーマのキー。個人情報・トークンは保存しない。 */
const THEME_STORAGE_KEY = 'solvi-theme';

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // 保存領域を読めない端末でも、OS設定で表示を続ける。
    return null;
  }
}

function osTheme(): Theme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * ライト/ダークの切替 (WP-P2-UIX-044 §14)。
 *
 * 初期値はOS設定。利用者が選んだテーマだけをブラウザに保存し、
 * サーバーには保存しない。保存領域の読み書きに失敗しても表示は壊さない。
 */
export function ThemeToggle({ compact = false }: { compact?: boolean } = {}) {
  // サーバーでは決められないため、マウント後に現在のテーマを反映する。
  const [theme, setTheme] = useState<Theme | null>(null);

  const select = useCallback((next: Theme) => {
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 保存できなくても、この画面では選んだテーマを使う。
    }
  }, []);

  useEffect(() => {
    // 初期化スクリプトが付けた値を最優先し、無ければ保存値・OS設定の順に見る。
    const applied = document.documentElement.getAttribute('data-theme');
    const initial: Theme =
      applied === 'light' || applied === 'dark' ? applied : (storedTheme() ?? osTheme());
    setTheme(initial);
    applyTheme(initial);
  }, []);

  useEffect(() => {
    // 保存した選択が無いときだけ、OSの変更に追従する。
    let media: MediaQueryList;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = () => {
      if (storedTheme()) return;
      const next = osTheme();
      setTheme(next);
      applyTheme(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    // 別タブで選んだテーマに合わせる。保存領域を読めない環境では何もしない。
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
      if (!next) return;
      setTheme(next);
      applyTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  if (compact) {
    const dark = theme === 'dark';
    const label = dark ? 'ライト表示に切り替える' : 'ダーク表示に切り替える';
    return (
      <button
        className="fs-support-theme"
        type="button"
        aria-label={label}
        title={label}
        onClick={() => select(dark ? 'light' : 'dark')}
      >
        <FreshserviceIcon name={dark ? 'sun' : 'moon'} size={18} />
      </button>
    );
  }

  return (
    <div className="fs-theme" role="group" aria-label="表示テーマ">
      <button type="button" aria-pressed={theme === 'light'} onClick={() => select('light')}>
        ライト
      </button>
      <button type="button" aria-pressed={theme === 'dark'} onClick={() => select('dark')}>
        ダーク
      </button>
    </div>
  );
}
