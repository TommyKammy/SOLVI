/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 本番イメージを小さく保つ。ADR-0018 の同一イメージ昇格に合わせる。
  output: 'standalone',
  // APIのベースURLはサーバ側でのみ解決する。ブラウザへ内部URLを露出させない。
  env: {},
};

export default nextConfig;
