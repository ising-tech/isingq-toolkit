# Security Policy

## Supported version

Security fixes are applied to the latest released version of `isingq-mcp`.

## Reporting a vulnerability

Send vulnerability reports privately to `contact@isingtech.com`. Include the affected version, reproduction conditions, impact, and a minimal proof of concept when available.

Do not place API Keys, QUBO matrices, task results, personal data, or unpublished company information in a public GitHub Issue. The project will acknowledge a complete report and coordinate validation and remediation through a private channel.

## Security boundaries

- The MCP and native DSH Plugin run locally. Interactive setup stores the personal IsingQ API Key in the user's private configuration.
- A Headless deployment administrator may inject `ISINGQ_API_KEY` before the Agent process starts. The runtime reads it without persisting it. An Agent must not request, set, print, or copy this value into chat, tool arguments, Host configuration, issues, or logs.
- Default Toolkit adapters pin production API requests to `https://api.isingq.com`; `ISINGQ_BASE_URL` is not a supported runtime setting. An embedded consumer that explicitly constructs `IsingQTransport` supplies its own endpoint and API Key provider outside the default adapter configuration.
- The API Key is sent only to the official IsingQ API for upload-signature, task-creation, and task-query requests. The signed OSS upload does not receive the personal API Key.
- The private API Key prompt starts only local operating-system components: `osascript` on macOS, PowerShell Forms on Windows, or `zenity`, `kdialog`, and `systemd-ask-password` on Linux. It does not download or execute remote scripts.
- Real solving sends the QUBO matrix to the IsingQ-provided signed upload endpoint as soon as the Host permits `isingq_solve_start`. The Agent must obtain explicit user confirmation before calling it; the Host may add its own tool-permission prompt. The MCP does not open a separate operating-system solve confirmation.
- The default npm path follows the `latest` dist-tag; users who need reproducible deployment or rollback should select an explicit version. Repository-bundled installers execute only the checked-out local source tree.
- Release binaries must come from the official GitHub repository, be tied to an immutable version, and be verified against the published manifest before execution. Remote pipe installers such as `curl | sh` and `irm | iex` are not supported; use npm or a verified GitHub Release.

## Node.js runtime and build dependencies

The IsingQ HTTP transport uses the exact runtime dependency `undici@6.29.1`, including its `fetch` and `FormData`, with `Blob` from `node:buffer`. It never falls back to Node.js's global `fetch`. Both the standalone core package and the MCP package (which embeds core sources) declare this runtime dependency; DSH obtains it through core. This fixes the Toolkit's response-decoding path for CVE-2026-109869 without requiring an upgrade of a Host's bundled Undici.

Install with `npm ci` to use the reviewed lockfile. The separate development dependency used by the legacy pkg-fetch path is locked to Undici 7.30.1. The current `pkg --sea` downloader still uses Node.js's global `fetch`, so build environments must separately use a maintained Node.js release containing the upstream fix. Node.js 24.22.2 (bundled Undici 7.30.1) was locally verified on macOS arm64 for that build boundary.

The packages require Node.js 18.17 or later for API compatibility; this minimum does not certify every matching runtime as secure. Local regression tests exercise the public `IsingQTransport` on Node.js 22.22.2, including six- and seven-layer malicious encodings with an early close, normal gzip, multipart upload, redirects, errors and timeouts. They use synthetic input routed only to loopback and do not establish exploitation of the production IsingQ endpoint. See the [upstream advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c).

This change covers requests made by the updated Toolkit transport. It does not patch unrelated global-fetch consumers, existing installations or previously built executables. Release binaries need rebuilding to incorporate the dependency, and their embedded Node.js runtime remains a separate security boundary.
