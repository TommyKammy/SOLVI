export type FreshserviceIconName =
  | 'dashboard'
  | 'ticket'
  | 'book'
  | 'grid'
  | 'asset'
  | 'change'
  | 'admin'
  | 'settings'
  | 'portal'
  | 'search'
  | 'plus'
  | 'bell'
  | 'help'
  | 'user'
  | 'menu'
  | 'chevron'
  | 'logout'
  | 'organization';

type Props = {
  name: FreshserviceIconName;
  size?: number;
  className?: string;
};

/**
 * Freshserviceの画面で使われている記号の「役割」だけを参考にした、
 * SOLVI用のインラインSVG。Freshworksのアイコン素材は複製しない。
 */
export function FreshserviceIcon({ name, size = 20, className }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className,
  };
  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
        </svg>
      );
    case 'ticket':
      return (
        <svg {...common}>
          <path d="M4 6.5h16v3a2.5 2.5 0 0 0 0 5v3H4v-3a2.5 2.5 0 0 0 0-5z" />
          <path d="M9 6.5v11" strokeDasharray="2 2" />
        </svg>
      );
    case 'book':
      return (
        <svg {...common}>
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" />
          <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22z" />
        </svg>
      );
    case 'grid':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2" />
          <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2" />
          <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2" />
          <path d="M14 17.2h6.5M17.2 14v6.5" />
        </svg>
      );
    case 'asset':
      return (
        <svg {...common}>
          <path d="M12 3.5 20 8l-8 4.5L4 8z" />
          <path d="m4 12 8 4.5 8-4.5" />
          <path d="m4 16 8 4.5 8-4.5" />
        </svg>
      );
    case 'change':
      return (
        <svg {...common}>
          <path d="M12 3.5 20 6v5.5c0 4.4-3.2 7.7-8 9-4.8-1.3-8-4.6-8-9V6z" />
          <path d="m8.5 12 2.2 2.2 4.8-4.8" />
        </svg>
      );
    case 'admin':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
          <path d="M16 5.5a3 3 0 0 1 0 5.8" />
          <path d="M17.5 14.5a5 5 0 0 1 3 4.5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" />
        </svg>
      );
    case 'portal':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.2 2.4 3.4 5.3 3.4 8.5s-1.2 6.1-3.4 8.5c-2.2-2.4-3.4-5.3-3.4-8.5S9.8 5.9 12 3.5z" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="10.8" cy="10.8" r="6.3" />
          <path d="m15.4 15.4 4.1 4.1" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path d="M18 9a6 6 0 0 0-12 0c0 7-2.5 7-2.5 8.5h17C20.5 16 18 16 18 9z" />
          <path d="M9.5 20a2.8 2.8 0 0 0 5 0" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.6 9.2a2.6 2.6 0 1 1 4.2 2.1c-.9.7-1.8 1.3-1.8 2.7" />
          <path d="M12 17.3h.01" />
        </svg>
      );
    case 'user':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    case 'menu':
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case 'logout':
      return (
        <svg {...common}>
          <path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10" />
          <path d="M14 8l4 4-4 4M18 12H9" />
        </svg>
      );
    case 'organization':
      return (
        <svg {...common}>
          <path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4H12v16" />
          <path d="M12 9h6.5A1.5 1.5 0 0 1 20 10.5V20" />
          <path d="M2.5 20h19M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2" />
        </svg>
      );
  }
}
