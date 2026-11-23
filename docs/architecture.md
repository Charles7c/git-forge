# Architecture

`MCP client → stdio server → GitClient → provider adapter → HTTP → provider API`

Applications enter at `GitClient`. The MCP package validates tool input, calls that same public SDK, and serializes results or `GitForgeError` for the client. MCP stdout is reserved for the protocol; startup diagnostics go to stderr. Neither consumers nor the server need to import SDK internals.

A facade call validates its arguments, checks read-only mode, credentials, method support and parameter support, **in that order**, before dispatch. Capability tables are static: discovering tools never probes a host or attempts a write. Each adapter translates endpoints, parameters and fields. Shared code handles authentication, timeouts, retries, pagination, redaction and bounded bulk concurrency. An adapter does not call another adapter. The SDK uses Node's built-in `fetch` and has no third-party runtime dependencies.

For a new provider, define its provider identity, endpoints, adapter, mappers and capability tables in the SDK; register it, declare the MCP token configuration and schema, and update the docs. Exercise the same five-domain contract tests plus provider-specific refusals with injected transport. Use a loopback responder to test wire behavior. Do not add provider branches to individual MCP tools or silently emulate unsupported atomic operations.

[Provider contract](./providers.md) · [Contributing](../CONTRIBUTING.md)
