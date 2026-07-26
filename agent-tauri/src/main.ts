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
const serverInput = document.querySelector<HTMLInputElement>('#server')!;
const codeInput = document.querySelector<HTMLInputElement>('#code')!;
const nameInput = document.querySelector<HTMLInputElement>('#name')!;

let isPaired = false;

function setStatus(status: string, detail: string | null): void {
  statusEl.textContent = `Status: ${status}${detail ? ` — ${detail}` : ''}`;
  statusEl.className = `status ${status}`;
}

function setInputsDisabled(disabled: boolean): void {
  serverInput.disabled = disabled;
  codeInput.disabled = disabled;
  nameInput.disabled = disabled;
}

function render(state: StateView): void {
  isPaired = state.paired;
  setStatus(state.status, state.detail);
  pairedNote.hidden = !state.paired;
  setInputsDisabled(state.paired);
  pairButton.textContent = state.paired ? 'Disconnect' : 'Pair & connect';
  pairButton.classList.toggle('danger', state.paired);
  if (state.server) serverInput.value = state.server;
  if (state.deviceName) nameInput.value = state.deviceName;
}

async function refresh(): Promise<void> {
  const state = await invoke<StateView>('get_state');
  render(state);
}

async function pairDevice(): Promise<void> {
  await invoke('pair', {
    server: serverInput.value.trim(),
    code: codeInput.value.trim(),
    name: nameInput.value.trim() || undefined,
  });
}

async function submitForm(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  pairButton.disabled = true;
  try {
    if (isPaired) {
      await invoke('unpair');
    } else {
      await pairDevice();
    }
    await refresh();
  } catch (error) {
    setStatus('error', String(error));
  } finally {
    pairButton.disabled = false;
  }
}

listen<StatusEvent>('agent-status', (event) => {
  setStatus(event.payload.status, event.payload.detail);
});

form.addEventListener('submit', submitForm);
refresh().catch((error) => setStatus('error', String(error)));
