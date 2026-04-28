/**
 * The ClosedMesh wordmark icon: three peer nodes arranged around a central
 * coordinator. Re-used in the header, the /about hero, the favicon, and the
 * matching closedmesh-llm/docs/closedmesh-logo.svg.
 */
export function Logo({
  size = 22,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <circle cx="12" cy="4" r="2.2" fill="var(--accent)" />
      <circle cx="4" cy="18" r="2.2" fill="var(--accent)" />
      <circle cx="20" cy="18" r="2.2" fill="var(--accent)" />
      <circle cx="12" cy="13" r="1.6" fill="var(--fg)" opacity="0.9" />
      <path
        d="M12 6.2 L12 11.4 M5.6 16.6 L10.6 13.5 M18.4 16.6 L13.4 13.5"
        stroke="var(--fg)"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}
