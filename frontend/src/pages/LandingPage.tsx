import { InstallSection } from '@/components/landing/InstallSection';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LoggedInSections } from '@/components/landing/LoggedInSections';
import { useMe } from '@/lib/hooks';

function Hero() {
  return (
    <div>
      <svg
        className="mx-auto mb-6 block"
        width="72"
        height="40"
        viewBox="0 0 72 40"
        fill="none"
        role="img"
        aria-label="Lemniscate logo"
      >
        <path
          d="M36 20 C36 8 14 4 8 14 C2 24 20 36 36 20 C52 4 70 16 64 26 C58 36 36 32 36 20 Z"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
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
      <footer className="border-t px-6 py-6 text-center font-mono text-sm text-muted-foreground">
        <a
          href="https://gitverse.ru/grigorii_fedorov/lemniscate"
          className="border-b border-border text-foreground hover:border-foreground"
        >
          gitverse.ru/grigorii_fedorov/lemniscate
        </a>
      </footer>
    </div>
  );
}
