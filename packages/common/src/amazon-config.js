/** Explicit opt-in: observing receipts never implies permission to settle orders. */
export function getAmazonPayConfig(env = process.env) {
  const enabled = env.AMAZON_PAY_ENABLED === 'true';
  const dryRun = env.AMAZON_PAY_DRY_RUN !== 'false';
  const matchingMode = env.AMAZON_PAY_MATCHING_MODE || 'observe';
  if (!['observe', 'slot'].includes(matchingMode)) throw new Error('Invalid AMAZON_PAY_MATCHING_MODE');
  return { enabled, dryRun, matchingMode, canSettle: enabled && !dryRun && matchingMode === 'slot' };
}
