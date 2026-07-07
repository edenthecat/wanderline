# Security Policy

## Supported versions

Wanderline is developed as a rolling release from `main`. Only the latest commit on `main` receives security fixes. There are no numbered releases yet.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately by emailing `edenrohatensky@gmail.com` with:

- A description of the vulnerability
- Steps to reproduce (or a proof-of-concept)
- What impact you think it has
- The commit SHA you tested against

You'll get an acknowledgment within 7 days. Time-to-fix depends on severity — critical issues (auth bypass, RCE, data exfiltration) get worked on first; lower-severity ones are queued alongside other work.

## Scope

**In scope**: the code under this repository, published Docker images, and the deployed instance at any URL under `wanderline.*` where I control the DNS.

**Out of scope**: DoS via traffic volume, social-engineering the maintainer, physical attacks, third-party dependencies (report those upstream).

## Disclosure

I aim to disclose fixed vulnerabilities in the release notes / commit log with credit to the reporter (unless you'd rather stay anonymous). If a fix has to break API compatibility or migration format, I'll document that clearly.

Thanks for helping keep Wanderline safe.
