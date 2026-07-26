/**
 * Particle config for the animated lemniscate logo: a swarm of dots
 * traveling along the infinity path at different speeds and phases.
 * Deterministic so server/client renders and snapshots stay stable.
 */

export interface SwarmParticle {
  /** Circle radius in viewBox units. */
  radius: number;
  /** Fill opacity 0–1. */
  opacity: number;
  /** Seconds per full loop around the lemniscate. */
  duration: number;
  /** Negative SMIL begin offset — particle starts already en route. */
  begin: number;
}

/** Cheap deterministic hash → [0, 1). */
function hash(index: number, salt: number): number {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function swarmParticles(count = 8): SwarmParticle[] {
  return Array.from({ length: count }, (_, i) => {
    const duration = 4 + hash(i, 1) * 4;
    return {
      radius: 0.55 + hash(i, 2) * 0.5,
      opacity: 0.45 + hash(i, 3) * 0.55,
      duration,
      begin: -hash(i, 4) * duration,
    };
  });
}
