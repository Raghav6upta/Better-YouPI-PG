import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('./whatsapp-logging-patch.json', import.meta.url), 'utf8'));
const digest = text => createHash('sha256').update(text).digest('hex');
const normalize = text => text.replace(/\r\n/g, '\n');

export function signalPackageDirectory() {
  // Resolve through the SDK transport, so the checked copy is the one it uses.
  const transportRequire = createRequire(require.resolve('@berrysdk/transport'));
  return path.dirname(transportRequire.resolve('libsignal/package.json'));
}

export function patchWhatsAppDependencyLogging(directory = signalPackageDirectory(), { checkOnly = false } = {}) {
  const root = path.resolve(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.package || pkg.version !== manifest.version) {
    throw new Error('WhatsApp logging patch needs review for this dependency version.');
  }
  // Validate every file before modifying any. Unknown dependency changes fail closed.
  const pending = [];
  for (const entry of manifest.files) {
    const file = path.resolve(root, entry.file);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid WhatsApp logging patch path.');
    const source = normalize(fs.readFileSync(file, 'utf8'));
    if (digest(source) === entry.after) continue;
    if (checkOnly || digest(source) !== entry.before) {
      throw new Error('WhatsApp logging protection is missing or outdated. Run npm run security:patch-whatsapp.');
    }
    let patched = source;
    for (const [from, to] of entry.replacements) {
      if (patched.split(from).length !== 2) throw new Error('WhatsApp logging patch does not match this dependency.');
      patched = patched.replace(from, to);
    }
    if (digest(patched) !== entry.after) throw new Error('WhatsApp logging patch verification failed.');
    pending.push({ file, patched });
  }
  for (const { file, patched } of pending) fs.writeFileSync(file, patched);
  return { patchedFiles: pending.length, checkedFiles: manifest.files.length };
}

export function assertWhatsAppLoggingSafe() {
  patchWhatsAppDependencyLogging(signalPackageDirectory(), { checkOnly: true });
}

// The SDK's structured logs can include device identifiers, protocol payloads and
// message content. Keep observability in our service's fixed status messages.
export const privateWhatsAppLogger = Object.freeze({
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, silent() {},
  child() { return this; }
});
