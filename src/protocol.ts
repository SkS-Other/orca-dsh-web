export {}

declare module 'orca' {
  interface PluginRequests {
    'dsh-web.panel.state': {
      output: {
        workspace: string | null
        host: string | null
        running: boolean
        origin: string | null
      }
    }
    'dsh-web.open': { output: string }
    'dsh-web.stop': { output: string }
    'dsh-web.restart': { output: string }
    'dsh-web.terminal': { output: string }
  }
}
