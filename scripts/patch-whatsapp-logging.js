import { patchWhatsAppDependencyLogging } from '../packages/common/src/whatsapp-dependency-logging.js';

try {
  const result = patchWhatsAppDependencyLogging();
  console.log(`[WhatsApp logging] Verified ${result.checkedFiles} dependency files; patched ${result.patchedFiles}.`);
} catch (error) {
  console.error(`[WhatsApp logging] ${error.message}`);
  process.exitCode = 1;
}
