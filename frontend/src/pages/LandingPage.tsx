import { InstallSection } from '@/components/landing/InstallSection';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LoggedInSections } from '@/components/landing/LoggedInSections';
import { LemniscateSwarm } from '@/components/LemniscateSwarm';
import { useMe } from '@/lib/hooks';
import { Github } from 'lucide-react';

/** Hero lemniscate: same mark as the nav logo, hand-tuned for 72×40. */
const HERO_PATH = 'M36 20 C36 8 14 4 8 14 C2 24 20 36 36 20 C52 4 70 16 64 26 C58 36 36 32 36 20 Z';

function Hero() {
  return (
    <div>
      <LemniscateSwarm
        className="mx-auto mb-6 block h-10 w-[72px] text-foreground"
        path={HERO_PATH}
        viewBox="0 0 72 40"
        strokeWidth={2.5}
        particleScale={3}
        label="Lemniscate logo"
      />
      <h1 className="text-center text-4xl font-bold tracking-tight">Lemniscate</h1>
      <p className="mt-2 text-center font-mono text-sm text-muted-foreground">
        {'// a self-improving codebase'}
      </p>
      <p className="mx-auto mt-6 max-w-xl text-center text-muted-foreground">
        Connect GitHub, GitVerse or GitLab, plug in your own LLM, and Lemniscate analyzes your
        repositories, then proposes and implements improvements, features and fixes as pull
        requests — with optional LLM review and auto-merge.
      </p>
    </div>
  );
}

const FEATURES = [
  {
    title: 'your own LLM',
    body: 'Any OpenAI-compatible endpoint — OpenAI, vLLM, Ollama, LM Studio — configured in the UI.',
  },
  {
    title: 'PRs, not patches',
    body: 'Proposals and fixes land as branches and pull requests on your git host.',
  },
  {
    title: 'review & auto-merge',
    body: 'Optional second-pass LLM review, with automatic merge when it approves.',
  },
  {
    title: 'live console',
    body: 'Watch the agent think, edit, commit and push in real time over SSE.',
  },
];

function FeaturesSection() {
  return (
    <section
      aria-label="Features"
      className="mt-14 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4"
    >
      {FEATURES.map((feature) => (
        <div key={feature.title} className="rounded-lg border bg-card p-4">
          <h3 className="mb-1.5 font-mono text-sm font-semibold">
            <span className="text-muted-foreground">∞ </span>
            {feature.title}
          </h3>
          <p className="text-xs text-muted-foreground">{feature.body}</p>
        </div>
      ))}
    </section>
  );
}

/**
 * / — public landing page (install instructions + features). When the visitor
 * is logged in it also shows their connected git hosts and running processes.
 */
export function LandingPage() {
  const me = useMe();
  return (
    <div className="flex min-h-screen flex-col">
      <LandingHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-16 pt-24">
        <Hero />
        <InstallSection />
        <FeaturesSection />
        {me.data && <LoggedInSections />}
      </main>
      <footer className="border-t px-6 py-6">
        <div className="flex items-center justify-center gap-5 text-muted-foreground">
          <a
            href="https://x.com/lemniscate_app"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Lemniscate on X"
            className="transition-colors hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <a
            href="https://github.com/grig-teo/lemniscate"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Lemniscate on GitHub"
            className="transition-colors hover:text-foreground"
          >
            <Github className="h-5 w-5" aria-hidden />
          </a>
        </div>
      </footer>
    </div>
  );
}
