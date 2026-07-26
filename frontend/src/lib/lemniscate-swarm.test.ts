import { describe, expect, it } from 'vitest';

import { swarmParticles } from './lemniscate-swarm';

describe('swarmParticles', () => {
  it('returns the requested number of particles', () => {
    expect(swarmParticles(8)).toHaveLength(8);
    expect(swarmParticles(3)).toHaveLength(3);
  });

  it('is deterministic across calls', () => {
    expect(swarmParticles()).toEqual(swarmParticles());
  });

  it('varies loop durations so the swarm churns instead of marching', () => {
    const durations = new Set(swarmParticles().map((p) => p.duration));
    expect(durations.size).toBeGreaterThan(1);
  });

  it('staggers begin offsets within one loop of each particle', () => {
    for (const p of swarmParticles()) {
      expect(p.begin).toBeLessThanOrEqual(0);
      expect(p.begin).toBeGreaterThan(-p.duration);
    }
  });

  it('keeps radius and opacity in renderable ranges', () => {
    for (const p of swarmParticles()) {
      expect(p.radius).toBeGreaterThan(0.4);
      expect(p.radius).toBeLessThan(1.2);
      expect(p.opacity).toBeGreaterThan(0.3);
      expect(p.opacity).toBeLessThanOrEqual(1);
    }
  });
});
