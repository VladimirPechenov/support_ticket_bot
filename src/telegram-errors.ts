/** Keep Telegram diagnostics operational: never log the request or message. */
export function telegramErrorMetadata(error: any): {
  errorReason: string;
  statusCode?: number;
} {
  const status = error?.error_code ?? error?.response?.error_code ?? error?.status;
  const statusCode = typeof status === 'number' ? status : undefined;
  const description = String(error?.description || error?.message || '').toLowerCase();
  const errorReason = /blocked/.test(description) ? 'bot_blocked' :
    statusCode === 403 ? 'forbidden' :
    /chat not found|user is deactivated/.test(description) ? 'recipient_unavailable' :
    statusCode === 429 ? 'rate_limit' :
    /timeout|timed out|aborted/.test(description) ? 'timeout' :
    statusCode === 400 ? 'bad_request' : 'telegram_send_failed';
  return {errorReason, statusCode};
}
