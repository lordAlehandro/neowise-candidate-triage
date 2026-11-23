export const TOPIC_LABELS = Object.freeze({
  delivery: "Доставка",
  pricing: "Цена и оплата",
  other: "Другое",
});

const DEFAULT_MANUAL_MESSAGE =
  "Не удалось разобрать заявку автоматически. Прочитайте текст и ответьте клиенту вручную. Предыдущий черновик очищен.";

export function manualViewModel(message = DEFAULT_MANUAL_MESSAGE) {
  return { kind: "manual_review", message, topic: null, draft: null };
}

export function loadingViewModel() {
  return { kind: "loading", message: "Разбираем заявку…", topic: null, draft: null };
}

/** Converts an API reply into a safe view model: no draft is kept on failure. */
export function toViewModel(reply) {
  const isReady =
    reply &&
    reply.status === "ready" &&
    Object.hasOwn(TOPIC_LABELS, reply.topic) &&
    typeof reply.draft === "string" &&
    reply.draft.trim() !== "";

  if (!isReady) return manualViewModel();

  return {
    kind: "ready",
    message: "Готово. Проверьте черновик перед отправкой клиенту.",
    topic: TOPIC_LABELS[reply.topic],
    draft: reply.draft,
  };
}
