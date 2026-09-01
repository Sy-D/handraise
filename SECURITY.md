# Security Policy

## Supported versions

handraise is pre-1.0. Only the latest `0.x` release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.x (latest) | ✅ |
| older 0.x | ❌ |

## Reporting a vulnerability

Please report vulnerabilities privately. Open a private security advisory on
GitHub for this repository (Security → Advisories → "Report a vulnerability").
Do not open a public issue for a suspected vulnerability.

We aim to acknowledge a report within a few working days and to keep you
updated as we work on a fix. Please give us a reasonable window to release a
patch before any public disclosure.

## Scope and threat model

handraise hands control of a running Solari cloud browser to a human for a
short assist (2FA, CAPTCHA, a manual step) and then returns control to the
agent. Keep the following in mind when assessing risk:

- **The handoff URL is a bearer link.** Anyone who holds the URL can drive the
  session for its lifetime. Treat it like a password: send it over a trusted
  channel, and expect it to expire.
- **The agent role is secret-protected.** The credentials that let the agent
  act are never embedded in the handoff link and are not exposed to the human
  operator.
- **The link is not arbitrary browser access.** It grants interaction with the
  specific handed-off session only — not a general-purpose remote browser or
  access to unrelated pages, tabs, or origins.

In-scope reports include: leakage of agent secrets, a handoff link granting
more than the intended session, a session that does not expire or revoke as
documented, and injection or interception in the relay path. Out of scope:
issues that require already holding a valid, unexpired handoff link (that is
the bearer model working as designed).
