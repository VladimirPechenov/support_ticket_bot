import * as db from './db';
import { logger } from './logger';

function getOpenTicket(
  userid: string | number,
  category: string | null,
): Promise<any> {
  return new Promise((resolve) => {
    logger.debug('getOpenTicket', `Fetching open ticket`, { userId: userid, category });
    db.getOpen(userid, category, function(ticket: any) {
      if (ticket) {
        logger.debug('getOpenTicket', `Found open ticket`, { ticketId: ticket.id, userId: userid });
      } else {
        logger.debug('getOpenTicket', `No open ticket found`, { userId: userid, category });
      }
      resolve(ticket);
    });
  });
}

function ensureOpenTicket(
  userid: string | number,
  category: string | null,
): Promise<any> {
  let ticket = db.getOpenSync(userid, category);
  if (!ticket) {
    db.add(userid, 'open', category);
    ticket = db.getOpenSync(userid, category);
  } else {
    db.touchTicket(ticket.id);
  }
  logger.debug('ensureOpenTicket', 'Open ticket ensured', {
    ticketId: ticket?.id,
    category,
  });
  return Promise.resolve(ticket);
}

function getTicketById(ticketId: string | number): Promise<any> {
  return new Promise((resolve) => {
    logger.debug('getTicketById', `Fetching ticket`, { ticketId });
    db.getId(ticketId as any, function(ticket: any) {
      if (ticket) {
        logger.debug('getTicketById', `Found ticket`, { ticketId: ticket.id, status: ticket.status });
      } else {
        logger.warn('getTicketById', `Ticket not found`, { ticketId });
      }
      resolve(ticket);
    });
  });
}

export { getOpenTicket, ensureOpenTicket, getTicketById };
