# Security Policy

## Supported version

Security fixes are applied to the latest released version of `isingq-mcp`.

## Reporting a vulnerability

Send vulnerability reports privately to `contact@isingtech.com`. Include the affected version, reproduction conditions, impact, and a minimal proof of concept when available.

Do not place API Keys, QUBO matrices, task results, personal data, or unpublished company information in a public GitHub Issue. The project will acknowledge a complete report and coordinate validation and remediation through a private channel.

## Security boundaries

- The MCP runs locally over stdio and stores the personal IsingQ API Key only in the user's private configuration.
- The API Key is sent only to the configured IsingQ API for upload-signature, task-creation, and task-query requests. The signed OSS upload does not receive the personal API Key.
- Real solving sends the QUBO matrix to the IsingQ-provided signed upload endpoint as soon as the Host permits `isingq_solve_start`. The Agent must obtain explicit user confirmation before calling it; the Host may add its own tool-permission prompt. The MCP does not open a separate operating-system solve confirmation.
- The default npm path follows the `latest` dist-tag; users who need reproducible deployment or rollback should select an explicit version. Repository-bundled installers execute only the checked-out local source tree.
- Release binaries must come from the official GitHub repository, be tied to an immutable version, and be verified against the published manifest before execution. Remote pipe installers such as `curl | sh` and `irm | iex` are not supported; use npm or a verified GitHub Release.
