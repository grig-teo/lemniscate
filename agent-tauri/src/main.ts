import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Matches the Rust `StateView` (camelCase) returned by `get_state`. */
type StateView = {
  status: string;
  detail: string | null;
  paired: boolean;
  server: string | null;
  deviceName: string | null;
};

type StatusEvent = { status: string; detail: string | null };

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const form = document.querySelector<HTMLFormElement>('#pair-form')!;
const pairedNote = document.querySelector<HTMLParagraphElement>('#paired-note')!;
const pairButton = document.querySelector<HTMLButtonElement>('#pair-button')!;
const unpairButton = document.querySelector<HTMLButtonElement>('#unpair-button')!;
const serverInput = document.querySelector<HTMLInputElement>('#server')!;
const codeInput = document.querySelector<HTMLInputElement>('#code')!;
const nameInput = document.querySelector<HTMLInputElement>('#name')!;

function setStatus(status: string, detail: string | null): void {
  statusEl.textContent = `Status: ${status}${detail ? ` — ${detail}` : ''}`;
  statusEl.className = `status ${status}`;
}

function render(state: StateView): void {
  setStatus(state.status, state.detail);
  pairedNote.hidden = !state.paired;
  form.hidden = state.paired;
  unpairButton.hidden = !state.paired;
  if (state.server) serverInput.value = state.server;
}

async function refresh(): Promise<void> {
  const state = await invoke<StateView>('get_state');
  render(state);
}

async function submitPairing(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  pairButton.disabled = true;
  try {
    await invoke('pair', {
      server: serverInput.value.trim(),
      code: codeInput.value.trim(),
      name: nameInput.value.trim() || undefined,
    });
    await refresh();
  } catch (error) {
    setStatus('error', String(error));
  } finally {
    pairButton.disabled = false;
  }
}

async function submitUnpair(): Promise<void> {
  unpairButton.disabled = true;
  try {
    await invoke('unpair');
    await refresh();
  } catch (error) {
    setStatus('error', String(error));
  } finally {
    unpairButton.disabled = false;
  }
}

listen<StatusEvent>('agent-status', (event) => {
  setStatus(event.payload.status, event.payload.detail);
});

form.addEventListener('submit', submitPairing);
unpairButton.addEventListener('click', () => void submitUnpair());
refresh().catch((error) => setStatus('error', String(error)));
