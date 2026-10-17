# Contributing

Thanks for your interest in improving this project!

## Reporting bugs

Open an [Issue](https://github.com/zjck2/CtrlV-imageBed/issues) and include:

1. Chrome version (`chrome://version`) and OS
2. What you did, what you expected, what actually happened
3. The exact error text from the upload card (or a screenshot of it)
4. Whether the paste happened on imgchr.com itself or on another site

## Before you propose a feature

Please read `README.md` → "How it works" first. In particular, proposals that require
extracting imgchr's one-time `auth_token` and replaying it cross-site, or otherwise
bypassing the host's CSRF protection, will be declined — even for uploads to your own
account. That is a deliberate design boundary of this project, not an oversight.

## Development

1. `git clone` this repo
2. Load the folder as an unpacked extension (`chrome://extensions` → Developer mode)
3. Make your changes, then reload the extension and test a real paste upload
4. Keep the ES5-style `var`/function coding style used across the codebase
5. All user-visible strings must go through `chrome.i18n.getMessage` with keys defined in
   both `_locales/zh_CN/messages.json` and `_locales/en/messages.json`

## Pull requests

Small, focused PRs are easiest to review. Describe what changed and why, and mention which
flows you tested (host-page upload, cross-site upload, timed deletion).
