# Jot DSH Session adapter

A Cordis plugin that connects the extended Jot gateway to an existing DSH Session Controller. It is not a standalone model server and cannot be launched with `node index.js` to create a complete runtime.

## Host requirements

The package declares these peer dependencies:

- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/dsh-api-session-controller` `0.1.7-alpha.2`

The host must provide `sessionController`, `fileUploads` and `agents`. When voice is enabled it must also provide `speechController` and a configured speech provider. These services, model credentials, Agent presets and actual tool backends are configured in the host; copying this directory does not create them.

Install the package in the host's dependency environment, import its `apply` function and register it through the host's Cordis plugin loader. A generic registration shape is:

```js
import * as jotSessionAdapter from '/absolute/path/to/jot/packages/session-adapter/index.js'

// hostContext already owns the required DSH services.
hostContext.plugin(jotSessionAdapter, {
  host: '127.0.0.1',
  port: 18841,
  tokenEnv: 'JOT_SESSION_ADAPTER_TOKEN',
  voiceEnabled: false,
})
```

This is the plugin registration boundary, not a complete DSH host bootstrap. Set the private `JOT_SESSION_ADAPTER_TOKEN` environment value before the host starts. This is also the plugin's default token environment name. Use a fresh random token of at least 32 characters. Put the identical value in the worker's private token file and point `GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE` at it. Do not commit either value.

Only loopback binding is accepted. Port defaults to `18841`. Gateway and host should share the same private machine/network namespace, or use a deliberate loopback tunnel; the gateway client rejects public adapter URLs. The adapter only accepts authenticated POST requests and has no public health endpoint.

## Protocol

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/sessions` | Create a session with a POSIX absolute `cwd` and an allowed preset |
| `POST /v1/sessions/{id}/prompts` | Send text, image or file receipt content; queue or steer |
| `POST /v1/sessions/{id}/follow` | Follow host messages as NDJSON; default 50, capped at 200 |
| `POST /v1/sessions/{id}/cancel` | Ask the host to cancel, then wait for idle; a detached host reports no live turn |
| `POST /v1/sessions/{id}/files` | Stage a file and return the host's receipt |
| `POST /v1/voice/*` | Speech operations, only when enabled in the host |

Allowed presets are `jot-general`, `jot-general-batch50` and `jot-general-batch`. Register them and their tool permissions in the host. Being in this allow-list is not proof a preset exists or that a batch browser service is available.

File/image receipts are session-scoped. Browser clients must use gateway conversation IDs rather than internal session IDs. The gateway performs owner checks; this trusted internal adapter receives host session IDs and must never be exposed directly to browsers.

## Voice

Keep `voiceEnabled: false` until the speech service is configured and inspected. Enabling the gateway's voice flag alone is insufficient. The gateway accepts at most 60 seconds / 2 MiB of WAV PCM mono 16 kHz 16-bit audio, obtains capability/provider readiness from the adapter and returns a transcription draft; it does not silently turn that draft into a sent chat message.

Run the included voice protocol tests with:

```sh
node --test voice.test.mjs
```

Mocked protocol tests do not establish that a real model, speech provider or browser action works in your host. Validate the complete chain after installing your providers.
