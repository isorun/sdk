# isorun

[![npm](https://img.shields.io/npm/v/isorun?logo=npm&label=npm)](https://www.npmjs.com/package/isorun)
[![types](https://img.shields.io/npm/types/isorun?logo=typescript&logoColor=white)](https://www.npmjs.com/package/isorun)
[![node](https://img.shields.io/node/v/isorun?logo=nodedotjs&logoColor=white&label=node)](https://www.npmjs.com/package/isorun)
[![provenance](https://img.shields.io/badge/provenance-signed-brightgreen?logo=github)](https://www.npmjs.com/package/isorun)
[![license](https://img.shields.io/npm/l/isorun?color=blue)](https://github.com/isorun/sdk/blob/main/LICENSE)
[![docs](https://img.shields.io/badge/docs-docs.isorun.ai-blue?logo=readthedocs&logoColor=white)](https://docs.isorun.ai)

Official TypeScript SDK for [Isorun](https://isorun.ai). Create an isolated Linux VM from any container image, run commands in it, read and write files, and tear it down — billed by the second.

## Install

```bash
npm install isorun
```

Requires Node.js 22.19 or newer.

## Quickstart

```ts
import { Isorun } from 'isorun'

const isorun = new Isorun() // reads ISORUN_API_KEY from env

const sandbox = await isorun.create({ image: 'node:22-slim' })

const { stdout } = await sandbox.exec('node -v')
console.log(stdout) // v22.x.x

await sandbox.destroy()
isorun.close() // release pooled connections so the process can exit
```

Get an API key at [app.isorun.ai](https://app.isorun.ai).

## Examples

### Run untrusted code

```ts
const sandbox = await isorun.create({ image: 'python:3.12-slim' })
try {
  await sandbox.writeFile('/tmp/code.py', sourceFromLLM)
  const { stdout } = await sandbox.exec('python /tmp/code.py', 30)
  return stdout
} finally {
  await sandbox.destroy()
}
```

### Fork a running sandbox

```ts
const parent = await isorun.create({ image: 'node:22-slim' })
await parent.writeFile('/app/worker.js', workerCode)

const workers = await parent.fork(10) // 10 independent clones
const results = await Promise.all(
  workers.map((w) => w.exec('node /app/worker.js')),
)
```

### Snapshot and restore

```ts
const base = await isorun.create({ image: 'python:3.12-slim' })
await base.exec('pip install pandas numpy')
const { id } = await base.snapshot()
await base.destroy()

// Later, restore a fresh sandbox from the snapshot
const restored = await isorun.restore(id)
await restored.exec('python -c "import pandas; print(pandas.__version__)"')
```

### Read and write files

```ts
await sandbox.writeFile('/app/config.json', JSON.stringify({ env: 'prod' }))
const contents = await sandbox.readFile('/app/config.json')
const entries = await sandbox.readdir('/app')
```

### Expose a guest port over HTTPS

```ts
const url = sandbox.url(3000) // URL for the guest's port 3000
// Send requests with an `Authorization: Bearer ${apiKey}` header.
```

## Agent frameworks

Use a sandbox as the code-execution tool in an agent stack. Each helper returns ready-to-use tools plus a `close()` to tear the sandbox down. The relevant peer dependency is installed only for the entry point you use.

### OpenAI Agents

```ts
import { isorunTools } from 'isorun/openai-agents'

const { tools, close } = await isorunTools()
// add `tools` to your Agent, then call close() when the run is done
```

### LangChain

```ts
import { isorunTools } from 'isorun/langchain'

const { tools, close } = await isorunTools()
// pass `tools` to a LangChain / LangGraph agent; close() when done
```

### MCP server

Expose the Isorun tools over stdio to any MCP client:

```bash
ISORUN_API_KEY=isorun_live_... npx isorun-mcp
```

### Claude Managed Agents

```ts
import { Isorun } from 'isorun'
import { runOrchestrator } from 'isorun/claude-agents/orchestrator'

await runOrchestrator({
  isorun: new Isorun(),
  environmentId: 'env_...',           // from the Anthropic Console
  environmentKey: 'sk-ant-oat01-...', // self-hosted environment key
  image: 'docker.io/isorun/claude-agents:0.4.3',
  vcpus: 2,
  memMiB: 4096,
})
```

See the [Claude Managed Agents guide](https://github.com/isorun/sdk/blob/main/src/claude-agents/README.md) for setup.

## API reference

### `new Isorun(options?)`

```ts
const isorun = new Isorun({ apiKey: 'isorun_live_...' })
```

| Option   | Type     | Default                 | Description                            |
| -------- | -------- | ----------------------- | -------------------------------------- |
| `apiKey` | `string` | `ISORUN_API_KEY` env    | Your API key.                          |
| `apiUrl` | `string` | derived from key region | Override the runner endpoint.          |

The runner URL is derived from the region encoded in the API key. `ISORUN_API_URL` also overrides it.

### Client methods

```ts
await isorun.create(options?)      // → Sandbox
await isorun.get(id)               // → Sandbox | null
await isorun.list()                // → Sandbox[]
await isorun.restore(snapshotId)   // → Sandbox
await isorun.listSnapshots()       // → Snapshot[]
await isorun.deleteSnapshot(id)    // → void
await isorun.networkProfiles()     // → NetworkProfile[]
await isorun.usage()               // → UsageSummary
await isorun.history()             // → SandboxHistoryEntry[]
await isorun.connect()             // optionally pre-open connections before issuing requests
isorun.close()                     // close pooled connections so the process can exit
```

### Sandbox methods

```ts
// Execute
await sandbox.exec(command, timeoutSec?)        // → { exitCode, stdout, stderr }

// Files
await sandbox.writeFile(path, content)          // string | Uint8Array
await sandbox.readFile(path)                     // → string
await sandbox.readdir(path)                      // → FileEntry[]

// URL builder for guest services
sandbox.url(port, path?)                         // → string

// Lifecycle
await sandbox.info()                             // → SandboxInfo
await sandbox.snapshot()                         // → Snapshot
await sandbox.fork(count?)                        // → Sandbox[]
await sandbox.hibernate()                        // pause + snapshot to disk
await sandbox.resume()                           // resume a hibernated sandbox
await sandbox.setTimeout(seconds)                // keep-alive; 0 disables auto-destroy
await sandbox.auditLog()                         // → AuditEntry[]
await sandbox.destroy()                          // → DestroyResult
```

All methods are fully typed; see the bundled `.d.ts` or [docs.isorun.ai](https://docs.isorun.ai).

### `CreateOptions`

| Field            | Type                                   | Default        | Notes                                  |
| ---------------- | -------------------------------------- | -------------- | -------------------------------------- |
| `image`          | `string`                               | `node:22-slim` | Container image.                       |
| `vcpus`          | `number`                               | `1`            | Virtual CPUs.                          |
| `memMiB`         | `number`                               | `1024`         | Memory in MiB.                         |
| `diskMiB`        | `number`                               | `4096`         | Scratch disk; wiped on destroy.        |
| `timeoutSec`     | `number`                               | `300`          | Auto-destroy timer; reset via `setTimeout`. |
| `network`        | `{ allow?: string[]; deny?: string[] }`| —              | Egress allow/deny lists (CIDRs, hostnames, wildcards). |
| `networkProfile` | `string`                               | —              | Named egress profile (see `networkProfiles()`). |
| `credentials`    | `Record<string, string>`               | —              | Credentials injected into the sandbox. |

`vcpus` and `memMiB` together select a sandbox size.

## Environment variables

| Variable         | Purpose                                             |
| ---------------- | --------------------------------------------------- |
| `ISORUN_API_KEY` | API key, used when not passed to the constructor.   |
| `ISORUN_API_URL` | Override the runner endpoint.                       |

## Errors

Every method throws an `IsorunError` on a non-2xx response. It carries the HTTP `status` and a truncated `body`, so you can branch by code:

```ts
import { Isorun, IsorunError } from 'isorun'

try {
  await sandbox.exec('...')
} catch (e) {
  if (e instanceof IsorunError && e.status === 429) backoff()
  else throw e
}
```

## Docs

Full guides and the complete API reference are at [docs.isorun.ai](https://docs.isorun.ai).

## License

[MIT](https://github.com/isorun/sdk/blob/main/LICENSE)
