import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { patchWhatsAppDependencyLogging, signalPackageDirectory, privateWhatsAppLogger } from '../whatsapp-dependency-logging.js';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('../whatsapp-logging-patch.json', import.meta.url), 'utf8'));

test('logging patch is repeatable and refuses unreviewed dependency contents before changing any file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-logging-test-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: manifest.package, version: manifest.version }));
    for (const entry of manifest.files) {
      let source = fs.readFileSync(path.join(signalPackageDirectory(), entry.file), 'utf8').replace(/\r\n/g, '\n');
      // Reconstruct the reviewed original from the installed, patched dependency.
      for (const [from, to] of entry.replacements) source = source.replace(to, from);
      fs.writeFileSync(path.join(root, entry.file), source);
    }
    assert.throws(() => patchWhatsAppDependencyLogging(root, { checkOnly: true }), /protection is missing/);
    const last = path.join(root, manifest.files.at(-1).file);
    const saved = fs.readFileSync(last, 'utf8');
    fs.appendFileSync(last, '\n// unreviewed change');
    const first = fs.readFileSync(path.join(root, manifest.files[0].file), 'utf8');
    assert.throws(() => patchWhatsAppDependencyLogging(root), /outdated/);
    assert.equal(fs.readFileSync(path.join(root, manifest.files[0].file), 'utf8'), first);
    fs.writeFileSync(last, saved);
    assert.equal(patchWhatsAppDependencyLogging(root).patchedFiles, 3);
    assert.equal(patchWhatsAppDependencyLogging(root).patchedFiles, 0);
    assert.equal(patchWhatsAppDependencyLogging(root, { checkOnly: true }).checkedFiles, 3);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: manifest.package, version: '999.0.0' }));
    assert.throws(() => patchWhatsAppDependencyLogging(root), /needs review/);
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('youpi-logging-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('real Signal session open, close and pruning never print key material', t => {
  patchWhatsAppDependencyLogging(signalPackageDirectory(), { checkOnly: true });
  const SessionRecord = require(path.join(signalPackageDirectory(), 'src/session_record.js'));
  const output = [];
  for (const method of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => output.push(inspect(args)));
  }
  const record = new SessionRecord();
  const session = { indexInfo: { closed: -1, used: 1 }, currentRatchet: { rootKey: 'SECRET_KEY_CANARY' } };
  record.closeSession(session);
  assert.notEqual(session.indexInfo.closed, -1);
  record.closeSession(session);
  record.openSession(session);
  assert.equal(session.indexInfo.closed, -1);
  for (let i = 0; i < 41; i++) record.sessions[String(i)] = {
    indexInfo: { closed: i + 1 }, currentRatchet: { rootKey: 'SECRET_KEY_CANARY' }
  };
  record.removeOldSessions();
  assert.equal(Object.keys(record.sessions).length, 40);
  privateWhatsAppLogger.child({ token: 'SECRET_KEY_CANARY' }).error({ body: 'OTP_CANARY' });
  assert.doesNotMatch(output.join('\n'), /SECRET_KEY_CANARY|OTP_CANARY|currentRatchet|rootKey/);
});
