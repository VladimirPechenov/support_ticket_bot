import cache from './cache';
import {Context} from './interfaces';
import * as db from './db';
import * as middleware from './middleware';
import {cancelActiveAiRuns} from './ai';

function isOwner(ctx: Context): boolean {
  if (!ctx.from?.id) return false;
  return [cache.config.owner_id, ...(cache.config.owner_ids || [])]
    .some(id => String(ctx.from.id) === String(id));
}

function deny(ctx: Context) {
  return middleware.reply(ctx, 'Недостаточно прав.', {parse_mode: 'none'});
}

function formatHealth(): string {
  const flags = db.getRuntimeFeatureFlags();
  const states = db.getAiProviderStates();
  const qdrant = cache.config.ai?.rag?.qdrant;
  const lines = [
    'AI health',
    `mode: ${flags.aiMode}`,
    `AI rollout: ${flags.aiRolloutPercent}%`,
    `web rollout: ${flags.webToolRolloutPercent}%`,
    `knowledge: ${flags.aiMode === 'full' ? 'complete local base, model decisions' : 'retrieval'}`,
    `Google key: ${process.env.GOOGLE_API_KEY ? 'configured' : 'missing'}`,
    `Mistral key: ${process.env.MISTRAL_API_KEY ? 'configured' : 'missing'}`,
    `Qdrant: ${qdrant?.url && qdrant?.collection ? 'configured' : 'missing'}`,
    `collection: ${qdrant?.collection || 'none'}`,
  ];
  for (const state of states) {
    lines.push(
      `${state.provider}: ${state.circuitState}` +
      ` · requests=${state.dailyRequests}` +
      ` · tokens=${state.dailyTokens}` +
      (state.lastErrorReason ? ` · last=${state.lastErrorReason}` : ''),
    );
  }
  return lines.join('\n');
}

export async function aiHealthCommand(ctx: Context) {
  if (!isOwner(ctx)) return deny(ctx);
  return middleware.reply(ctx, formatHealth(), {parse_mode: 'none'});
}

export async function aiControlCommand(ctx: Context) {
  if (!isOwner(ctx)) return deny(ctx);
  const input = String((ctx as any).match || '').trim();
  const [target, value] = input.split(/\s+/, 2);
  const previous = db.getRuntimeFeatureFlags();
  let cancelReason: string | undefined;
  try {
    if (target === 'mode' && ['off', 'rag_only', 'full'].includes(value)) {
      db.setRuntimeFeatureFlag('ai_mode', value as db.AiRuntimeMode);
      if (value !== previous.aiMode) cancelReason = 'runtime_mode_changed';
    } else if (
      target === 'ai' &&
      ['0', '5', '25', '50', '100'].includes(value)
    ) {
      const percent = Number(value);
      db.setRuntimeFeatureFlag('ai_rollout_percent', percent);
      if (percent < previous.aiRolloutPercent) {
        cancelReason = 'runtime_ai_rollout_reduced';
      }
    } else if (
      target === 'web' &&
      ['0', '5', '25', '50', '100'].includes(value)
    ) {
      const percent = Number(value);
      db.setRuntimeFeatureFlag('web_tool_rollout_percent', percent);
      if (percent < previous.webToolRolloutPercent) {
        cancelReason = 'runtime_web_rollout_reduced';
      }
    } else {
      return middleware.reply(
        ctx,
        'Использование:\n' +
        '/aictl mode off|rag_only|full\n' +
        '/aictl ai 0|5|25|50|100\n' +
        '/aictl web 0|5|25|50|100',
        {parse_mode: 'none'},
      );
    }
  } catch (_error) {
    return middleware.reply(ctx, 'Настройка отклонена.', {parse_mode: 'none'});
  }
  if (cancelReason) cancelActiveAiRuns(cancelReason);
  return middleware.reply(ctx, formatHealth(), {parse_mode: 'none'});
}

export async function ticketDiagnosticsCommand(ctx: Context) {
  if (!isOwner(ctx)) return deny(ctx);
  const reply = ctx.message?.reply_to_message;
  if (!reply?.message_id) {
    return middleware.reply(
      ctx,
      'Ответьте командой /ticket на карточку тикета.',
      {parse_mode: 'none'},
    );
  }
  const ticket = db.getTicketByTelegramMessage(ctx.chat.id, reply.message_id);
  if (!ticket) {
    return middleware.reply(ctx, 'Карточка тикета не найдена.', {
      parse_mode: 'none',
    });
  }
  const session = cache.aiSessions?.[String(ticket.id)];
  const diagnostics = (session?.runId ?
    db.getAiRunDiagnostics(session.runId) : null) ||
    db.getLatestAiRunDiagnosticsForTicket(ticket.id);
  const lines = [
    `Тикет #T${String(ticket.id).padStart(6, '0')}`,
    `stage: ${ticket.stage || 'unknown'}`,
    `AI: ${ticket.ai_enabled === 0 ? 'disabled' : 'enabled'}`,
    `handoff: ${ticket.handoff_reason || 'none'}`,
  ];
  if (diagnostics) {
    lines.push(
      `run: ${diagnostics.run.status} · ${diagnostics.run.route}`,
      `RAG: ${diagnostics.run.ragStatus}`,
      `latency: ${diagnostics.run.latencyMs || 0} ms`,
    );
    for (const attempt of diagnostics.providerAttempts) {
      lines.push(
        `${attempt.provider}/${attempt.model}: ${attempt.outcome}` +
        (attempt.errorReason ? ` (${attempt.errorReason})` : '') +
        ` · ${attempt.latencyMs || 0} ms`,
      );
    }
    for (const tool of diagnostics.toolRuns) {
      lines.push(
        `${tool.toolName}: ${tool.outcome}` +
        ` · results=${tool.resultCount} · ${tool.latencyMs || 0} ms`,
      );
    }
    for (const rejection of diagnostics.answerRejections) {
      lines.push(`Answer validation: ${rejection.reason}`);
      if (rejection.details.unsupportedFacts?.length) {
        lines.push('Unsupported facts: ' +
          rejection.details.unsupportedFacts.join(', '));
      }
    }
  }
  return middleware.reply(ctx, lines.join('\n'), {parse_mode: 'none'});
}

export {formatHealth};
