import { obj, probe, str, num, streamJson, toolLine } from './stream.js'
import type { Engine, RunOptions, RunResult } from './types.js'

// Hermes Agent (Nous Research): `hermes chat -q ... --format stream-json`, for API models
// (DeepSeek, OpenRouter, OpenAI API, local). The model may be "provider:model"; the provider
// alone comes from hermes' own config otherwise. Sessions are not resumed: each run is fresh.
export function hermesEngine(defaultProvider: string): Engine {
  return {
    id: 'hermes',
    label: 'Hermes',
    async run(opts: RunOptions): Promise<RunResult> {
      const [provider, model] = opts.model.includes(':') ? (opts.model.split(/:(.+)/) as [string, string]) : [defaultProvider, opts.model]
      const args = ['chat', '-q', opts.prompt, '--format', 'stream-json', '-Q', '--yolo']
      if (provider) args.push('--provider', provider)
      if (model) args.push('-m', model)
      let text = ''
      let sessionId: string | null = null
      let costUsd: number | null = null
      let tokens: number | null = null
      const { exitCode, stderr } = await streamJson('hermes', args, opts.cwd, opts.logFile, (o) => {
        const type = str(o.type)
        const sid = str(o.session_id)
        if (sid && !sessionId) {
          sessionId = sid
          opts.onSession?.(sid)
        }
        if (type === 'result') {
          text = str(o.result) || str(o.text) || str(o.content) || text
          costUsd = num(o.cost_usd) ?? num(o.total_cost_usd) ?? costUsd
          const usage = obj(o.usage)
          tokens = (num(usage.input_tokens) ?? num(usage.prompt_tokens) ?? 0) + (num(usage.output_tokens) ?? num(usage.completion_tokens) ?? 0) || tokens
          return
        }
        if (/tool/.test(type)) {
          const name = str(o.name) || str(o.tool) || str(obj(o.tool_call).name)
          if (name) opts.onLine?.('tool', toolLine(name, obj(o.arguments ?? o.args ?? obj(o.tool_call).arguments)))
          return
        }
        const t = str(o.text) || str(o.content) || str(o.delta)
        if (t.trim() && /message|assistant|text/.test(type)) opts.onLine?.('text', t.trim())
      }, process.env, opts.signal)
      return { sessionId: null, text, exitCode, costUsd, model: model || null, tokens, stderr }
    },
    async health() {
      const v = await probe('hermes', ['--version'])
      if (!v.ok) return { installed: false, signedIn: null, version: null, detail: 'not installed: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash' }
      return { installed: true, signedIn: null, version: v.out.split('\n')[0] ?? null, detail: `provider ${defaultProvider || 'from hermes config'}` }
    },
  }
}
