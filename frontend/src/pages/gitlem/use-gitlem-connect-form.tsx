import * as React from 'react';

import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import type { useGitlemLogin, useGitlemRegister, useGitlemRequestCode } from '@/lib/hooks';

type LoginMut = ReturnType<typeof useGitlemLogin>;
type RequestCodeMut = ReturnType<typeof useGitlemRequestCode>;
type RegisterMut = ReturnType<typeof useGitlemRegister>;

type Mode = 'login' | 'register-code' | 'register-finalize';

// The gitlem connect form is a small state machine:
//   login             — email + password (POST /login)
//   register-code     — email, request a 6-digit code (POST /register/code)
//   register-finalize — email + code (+ optional password), finish (POST /register)
// Each transition posts one endpoint; on a terminal success the caller navigates.
export function useGitlemConnectForm(opts: {
  login: LoginMut;
  requestCode: RequestCodeMut;
  register: RegisterMut;
  onDone: () => void;
}) {
  const { login, requestCode, register, onDone } = opts;
  const [mode, setMode] = React.useState<Mode>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [storedEmail, setStoredEmail] = React.useState(''); // email locked after requesting code

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'login') {
      login.mutate({ email, password }, { onSuccess: onDone });
      return;
    }
    if (mode === 'register-code') {
      requestCode.mutate(
        { email },
        { onSuccess: () => { setStoredEmail(email); setMode('register-finalize'); } },
      );
      return;
    }
    register.mutate(
      { email: storedEmail || email, code, password: password.trim() || undefined },
      { onSuccess: onDone },
    );
  };

  const toggleMode = () => {
    setMode((m) => (m === 'login' ? 'register-code' : 'login'));
    setCode('');
  };

  return {
    mode: mode === 'login' ? 'login' : 'register',
    submit,
    toggleMode,
    fields: renderFields(mode, { email, setEmail, password, setPassword, code, setCode }),
    error: activeError(mode, login, requestCode, register),
    notice: mode === 'register-finalize'
      ? `Enter the 6-digit code sent to ${storedEmail}. Leave the password blank to have one emailed.`
      : null,
    submitLabel: submitLabel(mode, login, requestCode, register),
    submitDisabled: submitDisabled(mode, { email, code }, login.isPending || requestCode.isPending || register.isPending),
  };
}

function submitLabel(mode: Mode, login: LoginMut, _req: RequestCodeMut, register: RegisterMut) {
  if (mode === 'login') return login.isPending ? 'Signing in…' : 'Sign in';
  if (mode === 'register-code') return _req.isPending ? 'Sending code…' : 'Send code';
  return register.isPending ? 'Registering…' : 'Register';
}

function submitDisabled(
  mode: Mode,
  values: { email: string; code: string },
  pending: boolean,
) {
  if (pending) return true;
  if (mode === 'register-finalize') return values.code.trim().length !== 6;
  return !values.email.trim();
}

function activeError(
  mode: Mode,
  login: LoginMut,
  requestCode: RequestCodeMut,
  register: RegisterMut,
): string | null {
  if (mode === 'login' && login.isError) return login.error.message;
  if (mode === 'register-code' && requestCode.isError) return requestCode.error.message;
  if (mode === 'register-finalize' && register.isError) return register.error.message;
  return null;
}

function renderFields(
  mode: Mode,
  v: {
    email: string; setEmail: (s: string) => void;
    password: string; setPassword: (s: string) => void;
    code: string; setCode: (s: string) => void;
  },
) {
  const emailField = (
    <FormField key="email" label="Email">
      <Input
        type="email"
        value={mode === 'register-finalize' ? v.email : undefined}
        placeholder={mode === 'register-finalize' ? v.email : 'you@example.com'}
        onChange={(e) => v.setEmail(e.target.value)}
        required
        disabled={mode === 'register-finalize'}
        autoComplete="email"
      />
    </FormField>
  );
  // In register-finalize the email is locked (storedEmail), so show it read-only.
  const finalizeEmail = (
    <FormField key="email" label="Email">
      <Input value={v.email} disabled autoComplete="email" />
    </FormField>
  );
  const passwordField = (
    <FormField key="password" label={mode === 'login' ? 'Password' : 'New password (optional)'}>
      <Input
        type="password"
        value={v.password}
        onChange={(e) => v.setPassword(e.target.value)}
        placeholder={mode === 'login' ? 'Your password' : 'Leave blank to get one by email'}
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
      />
    </FormField>
  );
  const codeField = (
    <FormField key="code" label="Registration code">
      <Input
        inputMode="numeric"
        maxLength={6}
        value={v.code}
        onChange={(e) => v.setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="123456"
        required
      />
    </FormField>
  );
  if (mode === 'login') return [emailField, passwordField];
  if (mode === 'register-code') return [emailField];
  return [finalizeEmail, codeField, passwordField];
}
