# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what is affected, how to reproduce it and what an attacker could do with it.

## Scope

Devot is in early development and has no binary releases; reports apply to the current `main` branch.

Crash reports go to Sentry only from a build made with `DEVOT_SENTRY_DSN` set; a build without it sends no crash reports.
