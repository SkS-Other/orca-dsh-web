export {}

declare module 'orca' {
  interface PluginRequests {
    'dsh-web.panel.state': {
      output: {
        workspace: string | null
        host: string | null
        profiles: { name: string; running: boolean; origin: string | null }[]
      }
    }
    'dsh-web.openProfile': { input: { profile: string }; output: string }
    'dsh-web.stopProfile': { input: { profile: string }; output: string }
    'dsh-web.stopAll': { output: string }
  }
}
