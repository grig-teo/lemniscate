import { swarmParticles } from '@/lib/lemniscate-swarm';

/** Lucide "infinity" path — the lemniscate the swarm travels along. */
const DEFAULT_PATH =
  'M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z';

const PARTICLES = swarmParticles();

interface LemniscateSwarmProps {
  className?: string;
  /** Path the swarm travels; defaults to the lucide infinity mark. */
  path?: string;
  viewBox?: string;
  strokeWidth?: number;
  /** Multiplies particle radii for larger viewBoxes. */
  particleScale?: number;
  /** Accessible label; when omitted the mark is decorative (aria-hidden). */
  label?: string;
  /**
   * Whether the swarm travels along the lemniscate. Defaults to true (e.g. the
   * marketing hero). Set false to show only the static mark — used by the brand
   * logo when no task is actively running or in review.
   */
  animate?: boolean;
}

/**
 * Animated brand mark: a faint static lemniscate with a swarm of dots
 * circulating along it (SMIL animateMotion — no JS animation loop).
 * The swarm is hidden under prefers-reduced-motion, leaving the mark.
 */
export function LemniscateSwarm({
  className,
  path = DEFAULT_PATH,
  viewBox = '0 0 24 24',
  strokeWidth = 2,
  particleScale = 1,
  label,
  animate = true,
}: LemniscateSwarmProps) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true } as const;
  return (
    <svg viewBox={viewBox} fill="none" className={className} {...a11y}>
      <path
        d={path}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.3}
      />
      {animate && (
        <g className="motion-reduce:hidden">
          {PARTICLES.map((p, i) => (
            <circle key={i} r={p.radius * particleScale} fill="currentColor" opacity={p.opacity}>
              <animateMotion
                path={path}
                dur={`${p.duration}s`}
                begin={`${p.begin}s`}
                repeatCount="indefinite"
              />
            </circle>
          ))}
        </g>
      )}
    </svg>
  );
}
