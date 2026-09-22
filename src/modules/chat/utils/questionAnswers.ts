/**
 * Folds the answers a user picked into an `AskUserQuestion` call's input, so the
 * question card shows what was chosen.
 *
 * The backend already does this in `prepareTranscriptMessages`, but only on a
 * history load. A live turn never goes through that pass, so until the session
 * was reopened the card sat there with every option unticked and a "2 questions"
 * title — as if the question had never been answered.
 *
 * This is a deliberate reimplementation of `server/shared/message-unification`'s
 * ask-the-user fold rather than a shared module: `src/` and `server/` have
 * separate type and util trees with no path alias between them, which is why
 * their shared vocabulary is duplicated throughout.
 */

type QuestionRecord = { question?: unknown; id?: unknown };

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readNonEmptyString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value : '';

/**
 * Flattens one answer value into the comma-joined label list the question view
 * renders. A multi-select answer arrives as an array; a single one as a string.
 */
function readAnswerLabels(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }

  const record = readRecord(value);
  return record ? readAnswerLabels(record.answers) : '';
}

/**
 * Recovers the answers from the acknowledgement sentence.
 *
 * A live turn only carries the prose result — `Your questions have been
 * answered: "<question>"="<answer>".` — because the structured `toolUseResult`
 * is written when the transcript is persisted, not when the tool returns.
 */
function readAnswersFromAcknowledgement(content: string): Record<string, string> {
  if (!content.includes('questions have been answered')) {
    return {};
  }

  const answers: Record<string, string> = {};
  const pattern = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(content);
  while (match) {
    answers[match[1]] = match[2];
    match = pattern.exec(content);
  }

  return answers;
}

/** Reads a payload stored either as an object or as the raw JSON string it arrived as. */
function readToolPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }
    try {
      return readRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  return readRecord(value);
}

/**
 * Rewrites answers onto the question text they belong to, since a provider may
 * key them by a question `id` instead.
 */
function keyAnswersByQuestion(
  questions: unknown,
  rawAnswers: Record<string, unknown>,
): Record<string, string> {
  const questionById = new Map<string, string>();
  if (Array.isArray(questions)) {
    for (const entry of questions) {
      const question = readRecord(entry) as QuestionRecord | null;
      const id = readNonEmptyString(question?.id);
      const text = readNonEmptyString(question?.question);
      if (id && text) {
        questionById.set(id, text);
      }
    }
  }

  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    const labels = readAnswerLabels(value);
    if (labels) {
      answers[questionById.get(key) ?? key] = labels;
    }
  }

  return answers;
}

/** Pulls the answer map out of whichever result shape arrived. */
function readAskAnswers(
  resultContent: unknown,
  toolUseResult: unknown,
): Record<string, unknown> | null {
  const structured = readRecord(readRecord(toolUseResult)?.answers);
  if (structured) {
    return structured;
  }

  const content = readNonEmptyString(resultContent);
  if (!content) {
    return null;
  }

  const fromPayload = readRecord(readToolPayload(content)?.answers);
  if (fromPayload) {
    return fromPayload;
  }

  const fromSentence = readAnswersFromAcknowledgement(content);
  return Object.keys(fromSentence).length > 0 ? fromSentence : null;
}

/**
 * Returns the tool input with the chosen answers merged in, or the input
 * unchanged when there is nothing to add.
 *
 * A history load arrives with the answers already folded in by the backend, and
 * that copy wins: it was built from the structured result rather than parsed
 * back out of a sentence.
 */
export function foldQuestionAnswers(toolInput: unknown, toolResult: {
  content?: unknown;
  toolUseResult?: unknown;
} | null): unknown {
  const input = readToolPayload(toolInput);
  if (!input || !Array.isArray(input.questions)) {
    return toolInput;
  }

  const existing = readRecord(input.answers);
  if (existing && Object.keys(existing).length > 0) {
    return toolInput;
  }

  const rawAnswers = readAskAnswers(toolResult?.content, toolResult?.toolUseResult);
  if (!rawAnswers) {
    return toolInput;
  }

  const answers = keyAnswersByQuestion(input.questions, rawAnswers);
  return Object.keys(answers).length > 0 ? { ...input, answers } : toolInput;
}
