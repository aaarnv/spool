// Small inline icons for the landing. Stroke-based, currentColor.

export function SpoolMark({ size = 26 }: { size?: number }) {
  const id = "spool-grad";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4b7bff" />
          <stop offset="0.5" stopColor="#39b7a6" />
          <stop offset="1" stopColor="#ff7a4d" />
        </linearGradient>
      </defs>
      {/* spool flanges */}
      <rect x="6" y="4" width="20" height="3.4" rx="1.7" fill={`url(#${id})`} />
      <rect x="6" y="24.6" width="20" height="3.4" rx="1.7" fill={`url(#${id})`} />
      {/* wound thread barrel */}
      <rect x="10" y="8.4" width="12" height="15.2" rx="2" fill={`url(#${id})`} opacity="0.28" />
      <line x1="10.6" y1="11.4" x2="21.4" y2="11.4" stroke={`url(#${id})`} strokeWidth="1.6" strokeLinecap="round" />
      <line x1="10.6" y1="14.7" x2="21.4" y2="14.7" stroke={`url(#${id})`} strokeWidth="1.6" strokeLinecap="round" />
      <line x1="10.6" y1="18" x2="21.4" y2="18" stroke={`url(#${id})`} strokeWidth="1.6" strokeLinecap="round" />
      <line x1="10.6" y1="21.3" x2="21.4" y2="21.3" stroke={`url(#${id})`} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function TerminalIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="3.2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M7 10l3 2.4L7 14.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 15h4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M10 8.6l5 3.4-5 3.4V8.6z" fill="currentColor" />
    </svg>
  );
}

export function PlayFill({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 3.2l8 4.8-8 4.8V3.2z" fill="currentColor" />
    </svg>
  );
}

export function StarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.6l2.7 5.9 6.4.7-4.8 4.3 1.3 6.3L12 17l-5.6 2.9 1.3-6.3-4.8-4.3 6.4-.7L12 2.6z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 10.5V7.8a4 4 0 018 0v2.7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}
