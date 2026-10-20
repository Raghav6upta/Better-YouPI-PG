export function receiptText({ date = new Date(), amount = '200.00', utr = '123456789012', reference = 'TEST-AMAZON-001', receiver = 'merchant@amazonpay', status = 'Received' } = {}) {
  const ist = new Date(date.getTime() + 330 * 60_000);
  const hour = ist.getUTCHours();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const timestamp = `${ist.getUTCDate()} ${months[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${hour % 12 || 12}:${String(ist.getUTCMinutes()).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
  return ['Transaction Details', status, `₹${amount}`, 'Received from', 'Example Payer', 'payer@upi',
    'Credited to', 'Amazon Pay UPI', receiver, 'UPI transaction ID', utr, 'Amazon reference ID', reference,
    'Date and time', timestamp].join('\n');
}
