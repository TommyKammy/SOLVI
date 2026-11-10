import Link from 'next/link';

export type DonutSegment = {
  label: string;
  value: number;
  color: string;
};

/**
 * 依存を増やさない小さなドーナツチャート (WP-P2-UIX-027)。
 *
 * 円グラフは色だけで区別させない。必ず凡例にラベルと件数を出す。
 * 0件のときに「半径0の円」を描くと、読み上げでは空の図に見えるため、
 * 明示的な空状態を返す。
 */
export function DonutChart({
  title,
  caption,
  segments,
  emptyLabel = '対象なし',
  href,
  hrefLabel,
}: {
  title: string;
  caption?: string;
  segments: DonutSegment[];
  emptyLabel?: string;
  /** 中央の合計から一覧へ移動するときのリンク先。 */
  href?: string;
  hrefLabel?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = 54;
  const stroke = 16;
  const size = 160;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const summary = segments.map((segment) => `${segment.label} ${segment.value}件`).join('、');

  return (
    <figure className="fs-donut">
      <figcaption className="fs-donut-heading">
        <span>{title}</span>
        {caption && <span className="hint">{caption}</span>}
      </figcaption>
      {total === 0 ? (
        <div className="fs-donut-empty">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={`${title}: ${emptyLabel}`}
          >
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="var(--fs-border)"
              strokeWidth={stroke}
            />
          </svg>
          <span>{emptyLabel}</span>
        </div>
      ) : (
        <div className="fs-donut-body">
          <div className="fs-donut-chart">
            <svg
              width={size}
              height={size}
              viewBox={`0 0 ${size} ${size}`}
              role="img"
              aria-label={`${title}: ${summary}`}
            >
              <circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke="var(--fs-surface-muted)"
                strokeWidth={stroke}
              />
              <g transform={`rotate(-90 ${center} ${center})`}>
                {segments
                  .filter((segment) => segment.value > 0)
                  .map((segment) => {
                    const length = (segment.value / total) * circumference;
                    const dashOffset = -offset;
                    offset += length;
                    return (
                      <circle
                        key={segment.label}
                        cx={center}
                        cy={center}
                        r={radius}
                        fill="none"
                        stroke={segment.color}
                        strokeWidth={stroke}
                        strokeDasharray={`${length} ${circumference - length}`}
                        strokeDashoffset={dashOffset}
                      />
                    );
                  })}
              </g>
              <text x={center} y={center - 2} textAnchor="middle" className="fs-donut-total">
                {total}
              </text>
              <text x={center} y={center + 16} textAnchor="middle" className="fs-donut-total-label">
                件
              </text>
            </svg>
            {href && (
              <Link className="fs-donut-center-link" href={href} prefetch={false}>
                <span className="visually-hidden">{hrefLabel ?? `${title}の一覧を見る`}</span>
              </Link>
            )}
          </div>
          <ul className="fs-donut-legend">
            {segments.map((segment) => (
              <li key={segment.label}>
                <span
                  className="fs-donut-swatch"
                  style={{ background: segment.color }}
                  aria-hidden="true"
                />
                <span className="fs-donut-label">{segment.label}</span>
                <span className="fs-donut-value">{segment.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </figure>
  );
}
