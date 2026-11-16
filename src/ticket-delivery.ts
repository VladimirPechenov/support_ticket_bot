import * as db from './db';
import {logger} from './logger';
import {
  recordTicketDeliveryFailure, recordTicketDeliverySuccess,
} from './operational-alerts';
import {telegramErrorMetadata} from './telegram-errors';

/** A staff reply is recorded only after Telegram returns a message ID. */
export async function deliverStaffReply(
  ticketId: string | number,
  send: () => Promise<any>,
  reason?: string,
): Promise<boolean> {
  let failure: ReturnType<typeof telegramErrorMetadata> | undefined;
  try {
    const sent = await send();
    if (!sent?.message_id) failure = {errorReason: 'telegram_send_failed'};
  } catch (error) {
    failure = telegramErrorMetadata(error);
  }
  if (failure) {
    db.recordTicketEvent(ticketId, {
      eventType: 'staff_reply_failed', actorType: 'staff', reason,
      errorReason: failure.errorReason,
    });
    logger.error('ticketDelivery', 'Staff reply delivery failed', {
      ticketId, ...failure,
    });
    await recordTicketDeliveryFailure(ticketId, failure.errorReason);
    return false;
  }
  db.touchTicket(ticketId);
  db.recordTicketEvent(ticketId, {
    eventType: 'staff_reply', actorType: 'staff', reason,
  });
  logger.info('ticketDelivery', 'Staff reply delivered', {ticketId});
  await recordTicketDeliverySuccess(ticketId);
  return true;
}
