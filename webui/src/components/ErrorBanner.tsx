interface ErrorBannerProps {
  message?: string;
  className?: string;
}

export function ErrorBanner({ message, className = '' }: ErrorBannerProps) {
  if (!message) return null;

  const classes = [
    'bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <div className={classes}>{message}</div>;
}
