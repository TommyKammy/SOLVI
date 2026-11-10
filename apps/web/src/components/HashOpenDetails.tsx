'use client';
import { useEffect } from 'react';

/**
 * アンカーが `<details>` を指したとき、その節を開く (WP-P2-UIX-026)。
 *
 * 添付や関連は、閉じたままでも要約は読める。ただし「添付」タブを押した
 * 利用者は中身を見たいので、移動先が閉じたままでは操作が一段増える。
 */
export function HashOpenDetails() {
  useEffect(() => {
    const openTarget = () => {
      const hash = window.location.hash;
      if (!hash) return;
      const target = document.getElementById(hash.slice(1));
      if (target instanceof HTMLDetailsElement) target.open = true;
    };
    openTarget();
    window.addEventListener('hashchange', openTarget);
    return () => window.removeEventListener('hashchange', openTarget);
  }, []);
  return null;
}
