import { swarmParticles } from '@/lib/lemniscate-swarm';

/** Lucide "infinity" path — the lemniscate the swarm travels along. */
const LEMNISCATE_PATH =
  'M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z';

const PARTICLES = swarmParticles();

/**
 * Animated brand mark: a faint static lemniscate with a swarm of dots
 * circulating along it (SMIL animateMotion — no JS animation loop).
 * The swarm is hidden under prefers-reduced-motion, leaving the mark.
 */
export function LemniscateSwarm({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d={LEMNISCATE_PATH}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.3}
      />
      <g className="motion-reduce:hidden">
        {PARTICLES.map((p, i) => (
          <circle key={i} r={p.radius} fill="currentColor" opacity={p.opacity}>
            <animateMotion
              path={LEMNISCATE_PATH}
              dur={`${p.duration}s`}
              begin={`${p.begin}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </g>
    </svg>
  );
}
