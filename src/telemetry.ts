let sent = false;
export function sendCompletion() {
  if (sent) return;
  sent = true;
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.src = "/_events/check-complete.gif";
}
