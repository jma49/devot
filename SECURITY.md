# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what is affected, how to reproduce it and what an attacker could do with it.

## Supported versions

Security fixes go into the latest release. Older releases are deleted when a newer one ships, so they get no fixes. While a beta newer than the latest stable release is out, it is supported too. Reports apply to the latest release and to the current `main` branch.

A fix ships as a new release; installed copies take it through the in-app updater.

## Release signing

Releases are published on [GitHub Releases](https://github.com/jma49/devot/releases). Releases from 1.0.5-beta2 on are signed with Devot's Developer ID certificate and notarized by Apple, so they open without a Gatekeeper warning. 1.0.4 and earlier were ad-hoc signed and not notarised, so macOS asks for confirmation the first time you open one (see the README, Download).

The updater accepts only bundles signed with Devot's updater key, and only when the signature records the version the update feed announces.

## Crash reports

Crash reports go to Sentry only from a build made with `DEVOT_SENTRY_DSN` set; a build without it sends no crash reports.
