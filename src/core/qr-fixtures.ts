/**
 * Payloads that must never become an "Open" button, shared by the two tests
 * that check the two locks.
 *
 * The agent classifies a scanned code and the phone checks it again before it
 * builds an anchor, because `kind` crosses a socket anybody holding the handoff
 * URL can write to. Two locks are only two locks if they check the same thing,
 * and the first version of this feature shipped a page that checked the scheme
 * and nothing else — so a forged `kind: "url"` on a payload with a tab in it
 * got an anchor. One list, asserted in `qr-scan.test.ts` against
 * `classifyLink` and in `e2e/ui.spec.ts` against the real page in a real
 * browser, with every entry forged as `kind: "url"`.
 *
 * Not test-only by accident: it lives beside the code it constrains so that a
 * new scheme trick is added in one place.
 */
export const NEVER_OPENABLE: readonly string[] = [
  "javascript:alert(document.cookie)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "file:///etc/passwd",
  "intent://scan/#Intent;scheme=zxing;end",
  // The URL parser deletes the tab and the newline, and the host it ends up
  // with is evil.example — while the string on the card still reads good.
  "https://good.example\t@evil.example/",
  "https://good.example\n@evil.example/",
  // No whitespace needed: everything before the `@` is a username.
  "https://good.example@evil.example/",
  "https://user:secret@evil.example/",
]
