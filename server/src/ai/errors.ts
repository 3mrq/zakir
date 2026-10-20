// Error codes for AI jobs and their Arabic messages for the user.

export type AIErrorCode =
  | 'NOT_INSTALLED'
  | 'NOT_LOGGED_IN'
  | 'USAGE_LIMIT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_OUTPUT'
  | 'PROCESS_ERROR'
  | 'AI_ERROR'
  | 'SERVER_RESTART';

const MESSAGES: Record<AIErrorCode, { message: string; fix?: string }> = {
  NOT_INSTALLED: {
    message: 'لم أجد برنامج Claude Code على جهازك.',
    fix: 'ثبّته من الطرفية بالأمر: npm.cmd install -g @anthropic-ai/claude-code ثم أعد تشغيل التطبيق. أو حدّد مسار claude.exe في CLAUDE_BIN داخل ملف .env',
  },
  NOT_LOGGED_IN: {
    message: 'برنامج Claude Code غير مسجّل الدخول.',
    fix: 'شغّل في الطرفية: claude auth login ثم أعد المحاولة.',
  },
  USAGE_LIMIT: {
    message: 'وصلت مؤقتًا إلى حد الاستخدام في اشتراكك.',
    fix: 'انتظر حتى يتجدد الحد ثم أعد المحاولة.',
  },
  TIMEOUT: { message: 'تجاوزت المهمة المهلة المحددة فأُوقفت.', fix: 'أعد المحاولة، وإن تكرر فقلّل حجم المدخلات.' },
  CANCELLED: { message: 'أُلغيت المهمة.' },
  INVALID_OUTPUT: {
    message: 'رد الذكاء الاصطناعي لم يطابق الشكل المطلوب حتى بعد إعادة المحاولة.',
    fix: 'أعد تشغيل المهمة. إن تكرر الخطأ فراجع ملف التعليمات الخاص بها في مجلد prompts.',
  },
  PROCESS_ERROR: { message: 'توقف برنامج Claude Code بشكل غير متوقع.', fix: 'أعد المحاولة، أو شغّل npm run check:claude للفحص.' },
  AI_ERROR: { message: 'أعاد Claude Code خطأ.', fix: 'أعد المحاولة بعد قليل.' },
  SERVER_RESTART: { message: 'توقفت المهمة لأن الخادم أُعيد تشغيله.', fix: 'أعد تشغيل المهمة.' },
};

export class AIError extends Error {
  constructor(
    public readonly code: AIErrorCode,
    /** Technical detail (logged, shown in small print). */
    public readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }

  get userMessage(): string {
    const m = MESSAGES[this.code];
    const parts = [m.message];
    if (this.detail && (this.code === 'AI_ERROR' || this.code === 'PROCESS_ERROR' || this.code === 'INVALID_OUTPUT')) {
      parts.push(`(${this.detail.slice(0, 300)})`);
    }
    if (m.fix) parts.push(`الحل: ${m.fix}`);
    return parts.join(' ');
  }
}

export const errorInfo = (code: AIErrorCode) => MESSAGES[code];
