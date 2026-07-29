let sent = false;
export function sendCompletion() {
  if (sent) return;
  sent = true;
  // This deliberately has no payload, query string, credentials, or referrer.
  // A deployment can count this fixed path from its delivery logs.
  void fetch("/_events/check-complete.gif", {
    method: "GET",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store"
  }).catch(() => undefined);
}
