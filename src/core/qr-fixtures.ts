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
  // Schemes. The first two are the ones everybody remembers; the rest are the
  // reason this is an allowlist.
  "javascript:alert(document.cookie)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "blob:https://example.com/6e0f2b3c-1111-2222-3333-444455556666",
  "content://com.android.contacts/contacts/1",
  "file:///etc/passwd",
  "intent://scan/#Intent;scheme=zxing;end",
  "vbscript:msgbox(1)",
  // A scheme nested inside an accepted one: only the outer protocol is what
  // `new URL` reports, so this has to be refused on the outer one.
  "intent://open#Intent;S.url=https%3A%2F%2Fexample.com;end",
  // The URL parser deletes the tab and the newline, and the host it ends up
  // with is evil.example — while the string on the card still reads good.
  "https://good.example\t@evil.example/",
  "https://good.example\n@evil.example/",
  // No whitespace needed: everything before the `@` is a username.
  "https://good.example@evil.example/",
  "https://user:secret@evil.example/",
  // Invisible by design. A right-to-left override reverses the visible tail of
  // a path; a zero-width space hides inside a hostname; the isolates do both
  // without leaving a mark on the screen.
  "https://example.com/‮gnp.exe",
  "https://exam​ple.com/x",
  "https://example.com/⁦a⁩b",
  // Actions rather than pages: a dialer control sequence and an authenticator
  // enrolment. Decoded, shown and copyable — never one tap away.
  "tel:*21*1234567890%23",
  "tel:+4915112345678",
  "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example",
]
