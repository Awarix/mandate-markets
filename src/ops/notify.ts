// Telegram alerts. Silent no-op when the env vars are unset, so nothing breaks in
// dev or in tests — an unconfigured notifier must never take the caller down.

const API = "https://api.telegram.org";

export function notifyConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** Sends a message. Never throws — an alert failing must not kill the caller,
 *  which is usually already handling something that went wrong. */
export async function notify(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[notify] telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[notify] failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
