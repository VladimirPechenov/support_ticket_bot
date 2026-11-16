import TelegramAddon from './addons/telegram';

interface ModeData {
  ticketid: string;
  userid: string | number;
  name: any;
  category: string;
}

interface SessionData {
  admin: boolean | null;
  mode: string | null;
  modeData: ModeData;
  groupCategory: string | null;
  group: string;
  groupAdmin: any;
  getSessionKey: Function;
}

interface Autoreply {
  question: string;
  answer: string;
}

interface Language {
  startCommandText: string;
  faqCommandText: string;
  helpCommandText: string;
  confirmationMessage: string;
  contactMessage: string; // left for backward compatibility
  blockedSpam: string;
  ticket: string;
  closed: string;
  acceptedBy: string;
  dear: string;
  regards: string;
  from: string;
  language: string;
  msg_sent: string;
  file_sent: string;
  usr_with_ticket: string;
  banned: string;
  replyPrivate: string;
  services: string;
  customer: string;
  msgForwarding: string;
  back: string;
  whatSubCategory: string;
  prvChatEnded: string;
  prvChatOpened: string;
  prvChatEnd: string;
  prvChatOpenedCustomer: string;
  instructionsSent: string;
  openTickets: string;
  support: string;
  prvChatOnly: string;
  ticketClosed: string;
  links: string;
  textFirst: string;
  ticketClosedError: string;
  automatedReply: string;
  automatedReplyAuthor: string;
  doesntHelp: string;
  automatedReplySent: string;
  ticketReopened: string;
  yourTicketId: string;
  helpCommandStaffText: string;
  regardsGroup: string;
  autoreply: Autoreply[];
}

interface AiMessage {
  role: string;
  content: string;
}

type AiAnswerMode = 'llm' | 'direct_rag';

interface AiLastAnswer {
  id: string;
  mode: AiAnswerMode;
  sourceId?: string;
  sourceTitle?: string;
  denseScore?: number;
  lexicalScore?: number;
  hybridScore?: number;
  denseRank?: number;
  lexicalRank?: number;
  model?: string;
  feedback?: 'helpful' | 'not_helpful' | 'operator';
}

interface AiSession {
  ticketId: string;
  userId: string | number;
  disabled: boolean;
  history: AiMessage[];
  lastHandoff?: string;
  offTopicWarnings?: number;
  lastAnswer?: AiLastAnswer;
  runId?: string;
  abortController?: AbortController;
  processingMessageId?: number;
  lastStaffCard?: {
    chatId: string | number;
    messageId: number;
    ticketId: string;
    question: string;
    user: {
      id: string | number;
      firstName: string;
      username?: string;
    };
  };
  lastStaffCardResult?: {
    status: 'answered';
    answer: string;
    mode: AiAnswerMode;
    sourceId?: string;
    sourceTitle?: string;
    denseScore?: number;
    lexicalScore?: number;
    fusedScore?: number;
    reason?: string;
  };
}

interface SupportConfig {
  custom_emoji?: boolean;
  ai_inactivity_close_ms?: number;
  metadata_retention_days?: number;
  maintenance_interval_ms?: number;
  mirror_ai_dialogs?: boolean;
  staff_card_mode?: string;
  ops_chat_id?: string | number;
  health_port?: number;
}

type AiRuntimeMode = 'off' | 'rag_only' | 'full';

interface AiProviderConfig {
  provider: 'gemini' | 'mistral';
  model: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  daily_request_limit?: number;
  daily_token_limit?: number;
  quota_stop_percent?: number;
  circuit_breaker?: {
    failure_threshold?: number;
    failure_window_ms?: number;
    cooldown_ms?: number;
  };
}

interface AiLlmConfig {
  providers?: {
    primary?: AiProviderConfig;
    fallback?: AiProviderConfig;
  };
  max_input_tokens?: number;
  deadline_ms?: number;
  max_attempts?: number;
}

interface AiEmbeddingsConfig {
  enabled?: boolean;
  provider?: 'gemini' | 'mistral';
  model?: string;
  dimensions?: number;
  timeout_ms?: number;
}

interface AiRagQdrantConfig {
  url?: string;
  collection?: string;
  top_k?: number;
  candidate_k?: number;
  rrf_k?: number;
  dense_weight?: number;
  dense_context_threshold?: number;
  lexical_context_threshold?: number;
  minimum_query_coverage?: number;
  max_context_docs?: number;
  max_doc_chars?: number;
  confidence_threshold?: number;
  direct_answer_on_llm_error?: boolean;
  direct_answer_min_margin?: number;
  history_query_messages?: number;
  payload_text_key?: string;
  payload_source_key?: string;
  payload_title_key?: string;
}

interface AiRagConfig {
  enabled?: boolean;
  vector_db?: string;
  qdrant?: AiRagQdrantConfig;
}

interface AiHandoffConfig {
  on_no_context?: boolean;
  on_low_confidence?: boolean;
  keywords?: string[];
  uncertain_phrases?: string[];
  user_message?: string;
  user_message_staff_stop?: string;
  staff_message?: string;
}

interface AiStaffForwardConfig {
  enabled?: boolean;
  takeover_button_text?: string;
  close_button_text?: string;
  resume_button_text?: string;
}

interface AiUserFeedbackConfig {
  enabled?: boolean;
  helpful_button_text?: string;
  not_helpful_button_text?: string;
  operator_button_text?: string;
}

interface AiOffTopicConfig {
  enabled?: boolean;
  detection_mode?: string; // 'keyword' or 'llm'
  keywords?: string[];
  max_warnings?: number;
  warning_message?: string;
}

interface AiConfig {
  enabled?: boolean;
  mode?: AiRuntimeMode;
  ai_rollout_percent?: number;
  web_tool_rollout_percent?: number;
  /** Telegram user IDs explicitly admitted before percentage rollout. */
  staff_allowlist?: Array<string | number>;
  system_prompt?: string;
  max_history_messages?: number;
  user_parse_mode?: string;
  processing_messages?: string[];
  llm?: AiLlmConfig;
  embeddings?: AiEmbeddingsConfig;
  rag?: AiRagConfig;
  handoff?: AiHandoffConfig;
  staff_forward?: AiStaffForwardConfig;
  user_feedback?: AiUserFeedbackConfig;
  off_topic?: AiOffTopicConfig;
  tools?: {
    verified_docs?: {
      enabled?: boolean;
      cache_path?: string;
      sync_interval_ms?: number;
    };
  };
}

interface Category {
  name: string;
  msg: string;
  group_id: string;
  subgroups: {
    name: string;
    group_id: string;
  }[];
}

interface Config {
  bot_token: string;
  spam_cant_msg: number;
  staffchat_id: string | number;
  owner_id: string;
  owner_ids?: Array<string | number>;
  spam_time: number;
  parse_mode: string;
  allow_private: boolean;
  direct_reply: boolean;
  auto_close_tickets: boolean;
  anonymous_tickets: boolean;
  anonymous_replies: boolean;
  show_auto_replied: boolean;
  dev_mode: boolean;
  show_user_ticket: boolean;
  language: Language;
  autoreply_confirmation: boolean;
  autoreply: Autoreply[];
  clean_replies: boolean;
  pass_start: boolean;
  categories: Category[];
  ai?: AiConfig;
  support?: SupportConfig;
}

interface Cache {
  ticketID: string;
  ticketIDs: any;
  ticketStatus: any;
  ticketSent: any;
  html: string;
  noSound: string;
  markdown: string;
  bot: TelegramAddon;
  config: Config;
  aiSessions: { [key: string]: AiSession };
}

/**
 * Context
 */
class Context {
  update_id: number;
  message: {
    message_id: number;
    from: {
      id: string;
      is_bot: false;
      first_name: string;
      username: string;
      language_code: string;
    };
    chat: {
      id: string;
      first_name: string;
      username: string;
      type: string;
    };
    date: number;
    text: string;
    reply_to_message: {
      message_id: number;
      from: { is_bot: boolean };
      text: string;
      caption: string;
    };
    getFile?: any;
    photo?: Array<{file_id: string; width?: number; height?: number}>;
    video?: {file_id: string};
    document?: {file_id: string};
    caption: string;
  };
  chat: {
    id: string;
    first_name: string;
    username: string;
    type: string;
  };
  session: SessionData;
  callbackQuery: {
    data: string;
    from: { id: any; first_name?: string; username?: string };
    id: any;
    message?: {text?: string; caption?: string};
  };
  from: { username: any; id: string };
  inlineQuery: any;
  reply: Function;
  answerCbQuery?: (arg0: any, arg1: boolean) => void;
  answerCallbackQuery?: (options?: any) => Promise<any>;
  getChat: Function;
  getFile: Function;
}

export {
  SessionData,
  Context,
  Language,
  Config,
  Cache,
  ModeData,
  AiConfig,
  AiRuntimeMode,
  AiSession,
  AiMessage,
  AiAnswerMode,
  AiLastAnswer,
  SupportConfig,
};
