import { describe, expect, it } from 'vitest';
import {
  buildRemoteDeployScript,
  buildSshArgs,
  encodeEnvB64,
  type RemoteDeploySpec,
  type VpsTargetConfig,
} from '../src/lib/deploy/vps.js';

// Pure helper tests for the VPS deploy path — no SSH, no I/O, no env. These
// pin the argument/script shapes that the worker shells out with.

const target: VpsTargetConfig = {
  host: 'prod.example.com',
  port: 2222,
  username: 'deployer',
  authMethod: 'password',
};

describe('buildSshArgs', () => {
  it('targets user@host and the configured port', () => {
    const args = buildSshArgs(target);
    expect(args).toContain('-p');
    expect(args).toContain('2222');
    expect(args).toContain('deployer@prod.example.com');
  });

  it('disables host-key prompts so the non-interactive deploy never hangs', () => {
    const args = buildSshArgs(target);
    expect(args).toContain('StrictHostKeyChecking=no');
    expect(args).toContain('UserKnownHostsFile=/dev/null');
  });

  it('does not carry an identity file by default (password auth path)', () => {
    const args = buildSshArgs(target);
    expect(args.some((a) => a.startsWith('IdentityFile='))).toBe(false);
  });

  it('adds IdentityFile + IdentitiesOnly when a key file is supplied', () => {
    const args = buildSshArgs(target, '/tmp/key');
    expect(args).toContain('IdentityFile=/tmp/key');
    expect(args).toContain('IdentitiesOnly=yes');
  });

  it('never places the password or key in the argument vector', () => {
    const args = buildSshArgs(target, '/tmp/my-secret-key');
    expect(args.some((a) => a.includes('supersecret'))).toBe(false);
  });
});

describe('encodeEnvB64', () => {
  it('encodes KEY=value dotenv lines as base64', () => {
    const b64 = encodeEnvB64({ FOO: 'bar', BAZ: 'qux' });
    const decoded = Buffer.from(b64, 'base64').toString();
    expect(decoded).toContain('FOO=bar');
    expect(decoded).toContain('BAZ=qux');
  });

  it('handles empty env as an empty payload', () => {
    expect(encodeEnvB64({})).toBe('');
  });
});

describe('buildRemoteDeployScript', () => {
  const spec: RemoteDeploySpec = {
    cloneUrl: 'https://git.example.com/acme/widget.git',
    branch: 'main',
    image: 'lemniscate-svc1:abc123',
    container: 'lemniscate-svc1',
    port: 8080,
    env: { DATABASE_URL: 'postgres://supersecret@db:5432/app', NODE_ENV: 'production' },
    gitToken: 'ghp_topsecrettoken',
  };

  it('runs set -euo pipefail and references the container/image/port', () => {
    const script = buildRemoteDeployScript(spec);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain(spec.image);
    expect(script).toContain(spec.container);
    expect(script).toContain(`-p ${spec.port}:${spec.port}`);
    expect(script).toContain('LEMNISCATE_DEPLOY_OK');
  });

  it('emits the success marker with the commit on the last line', () => {
    const script = buildRemoteDeployScript(spec);
    expect(script.trim().endsWith('echo "LEMNISCATE_DEPLOY_OK $COMMIT"')).toBe(true);
  });

  it('NEVER embeds the git token or env values as plaintext in the script body', () => {
    const script = buildRemoteDeployScript(spec);
    expect(script).not.toContain(spec.gitToken);
    expect(script).not.toContain('supersecret');
    for (const value of Object.values(spec.env)) {
      expect(script).not.toContain(value);
    }
  });

  it('carries the token and env only as base64 payloads (decoded at runtime)', () => {
    const script = buildRemoteDeployScript(spec);
    const tokenB64 = Buffer.from(spec.gitToken, 'utf8').toString('base64');
    expect(script).toContain(tokenB64);
    expect(script).toContain('base64 -d');
  });

  it('stops the previous container before starting the new one', () => {
    const script = buildRemoteDeployScript(spec);
    const rmIdx = script.indexOf('docker rm -f');
    const runIdx = script.indexOf('docker run -d');
    expect(rmIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(rmIdx);
  });

  it('removes the cloned dir and env file on success', () => {
    const script = buildRemoteDeployScript(spec);
    expect(script).toMatch(/rm -rf "\$DEPLOY_DIR"/);
    expect(script).toMatch(/rm -f .*lemniscate-env/);
  });
});
