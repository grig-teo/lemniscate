// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGitlemConnectForm } from '@/pages/gitlem/use-gitlem-connect-form';

// Locks the gitlem connect form state machine:
//  - login posts { email, password } and calls onDone on success
//  - register flow: send-code advances to the code step, then register posts
//    { email, code } and calls onDone
// Mutations are fakes that capture the call + invoke the onSuccess hook.

afterEach(cleanup);

function makeFakeMut() {
  let onSuccess: ((data: unknown) => void) | undefined;
  return {
    mutate: vi.fn((_vars: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      onSuccess = opts?.onSuccess;
    }),
    isError: false,
    isPending: false,
    error: { message: '' },
    // test helper: resolve the captured mutation as a success
    resolve: (data: unknown) => onSuccess?.(data),
  };
}

describe('useGitlemConnectForm', () => {
  it('starts in login mode and posts email+password on submit', () => {
    const done = vi.fn();
    const login = makeFakeMut();
    // Re-render the real form against the fake to assert the submit payload.
    function LoginHarness() {
      const form = useGitlemConnectForm({
        login: login as never,
        requestCode: makeFakeMut() as never,
        register: makeFakeMut() as never,
        onDone: done,
      });
      return (
        <form data-testid="form" onSubmit={form.submit}>
          {form.fields}
          <button type="submit">submit</button>
        </form>
      );
    }
    render(<LoginHarness />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'secret' } });
    fireEvent.submit(screen.getByTestId('form'));
    expect(login.mutate).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' }, expect.any(Object));
    login.resolve({ ok: true });
    expect(done).toHaveBeenCalled();
  });

  it('register flow: send code advances to the code step, then register posts { email, code }', async () => {
    const done = vi.fn();
    const requestCode = makeFakeMut();
    const register = makeFakeMut();
    function RegHarness() {
      const form = useGitlemConnectForm({
        login: makeFakeMut() as never,
        requestCode: requestCode as never,
        register: register as never,
        onDone: done,
      });
      return (
        <form data-testid="form" onSubmit={form.submit}>
          {form.fields}
          <button type="submit">submit</button>
          <button type="button" data-testid="toggle" onClick={form.toggleMode}>toggle</button>
        </form>
      );
    }
    render(<RegHarness />);
    // Switch to register mode and request a code.
    fireEvent.click(screen.getByTestId('toggle'));
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.submit(screen.getByTestId('form'));
    expect(requestCode.mutate).toHaveBeenCalledWith({ email: 'a@b.com' }, expect.any(Object));
    // Backend confirms the code was sent → advance to the finalize step.
    await act(async () => {
      requestCode.resolve({ ok: true });
    });
    // Now the code field is present (state has advanced).
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.submit(screen.getByTestId('form'));
    expect(register.mutate).toHaveBeenCalledWith(
      { email: 'a@b.com', code: '123456', password: undefined },
      expect.any(Object),
    );
    await act(async () => {
      register.resolve({ ok: true });
    });
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
});
